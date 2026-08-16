// ============================================================================
//  TEST · CollectVesselObservations — ngữ nghĩa use case, provider giả lập
// ----------------------------------------------------------------------------
//  Không mạng, không DB. Kiểm phần use case CHỊU TRÁCH NHIỆM: tra registry,
//  chạy qua executor, phân biệt NOT_FOUND với lỗi thật, đẩy sang recorder.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSourceMetadata } from "../../domain/value-objects/SourceMetadata";
import { mmsiIdentifier } from "../../domain/value-objects/VesselIdentifier";
import { VesselSource } from "../../domain/enums/VesselSource";
import { InMemoryVesselObservationRepository } from "../../infrastructure/persistence/memory/InMemoryVesselObservationRepository";
import { ObservationRecorder } from "../services/observation/ObservationRecorder";
import { ProviderRegistry } from "../services/acquisition/ProviderRegistry";
import { ProviderDetailsResult } from "../contracts/providers/ProviderResults";
import { ProviderOperation, VesselDataProvider } from "../contracts/providers/VesselDataProvider";
import { SourceErrorCategory, SourceRequestError, parseError } from "../services/crawl-runtime/SourceError";
import { SourceHealthState } from "../services/crawl-runtime/SourceHealthTracker";
import { SourceRuntimeManager } from "../services/crawl-runtime/SourceRuntimeManager";
import { CollectStatus, CollectVesselObservations } from "./CollectVesselObservations";

const SOURCE = VesselSource.SHIPINFO;
const MMSI = "636018086";
const FETCHED_AT = new Date("2026-08-14T08:00:00.000Z");
const IDENTIFIER = mmsiIdentifier(MMSI);

function detailsResult(): ProviderDetailsResult {
  const metadata = createSourceMetadata({ source: SOURCE, fetchedAt: FETCHED_AT });
  return { identity: { mmsi: MMSI, name: "Agia Doxa", metadata } };
}

interface Harness {
  useCase: CollectVesselObservations;
  repo: InMemoryVesselObservationRepository;
  runtime: SourceRuntimeManager;
  calls: number;
}

function harness(provider?: VesselDataProvider): Harness {
  const registry = new ProviderRegistry();
  if (provider) registry.register(provider);

  const repo = new InMemoryVesselObservationRepository({ now: () => FETCHED_AT });
  const runtime = new SourceRuntimeManager({ sleep: async () => undefined });
  const state = { calls: 0 };

  const useCase = new CollectVesselObservations({
    registry,
    runtime,
    recorder: new ObservationRecorder({ repository: repo, now: () => FETCHED_AT }),
    parserVersionBySource: { [SOURCE]: "test-v1" },
  });

  return {
    useCase,
    repo,
    runtime,
    get calls() {
      return state.calls;
    },
  } as Harness;
}

/** Provider giả: đếm số lần gọi, trả/ném theo kịch bản. */
function fakeProvider(behaviour: () => Promise<ProviderDetailsResult | null>): {
  provider: VesselDataProvider;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      source: SOURCE,
      async getDetails() {
        calls += 1;
        return behaviour();
      },
      async getPosition() {
        return null;
      },
    },
  };
}

test("chưa có provider -> NO_PROVIDER, không chạm runtime", async () => {
  const { useCase, runtime } = harness();
  const result = await useCase.execute({ source: SOURCE, identifier: IDENTIFIER });

  assert.equal(result.status, CollectStatus.NO_PROVIDER);
  assert.deepEqual([...result.observations], []);
  assert.deepEqual([...runtime.getInitializedSources()], [], "không dựng runtime vô ích");
});

test("provider không implement operation -> UNSUPPORTED_OPERATION", async () => {
  const detailsOnly: VesselDataProvider = {
    source: SOURCE,
    async getDetails() {
      return null;
    },
  };
  const { useCase } = harness(detailsOnly);

  const result = await useCase.execute({
    source: SOURCE,
    identifier: IDENTIFIER,
    operation: ProviderOperation.SCAN_AREA as never,
  });
  assert.equal(result.status, CollectStatus.UNSUPPORTED_OPERATION);
});

test("thành công -> RECORDED + observation đi qua recorder", async () => {
  const { provider } = fakeProvider(async () => detailsResult());
  const { useCase, repo } = harness(provider);

  const result = await useCase.execute({ source: SOURCE, identifier: IDENTIFIER });

  assert.equal(result.status, CollectStatus.RECORDED);
  assert.equal(result.observations.length, 1);
  assert.equal(repo.size, 1);
  assert.equal(repo.all()[0].source, SOURCE);
  assert.equal(repo.all()[0].parserVersion, "test-v1");
  assert.equal(result.health?.state, SourceHealthState.HEALTHY);
});

test("provider trả null -> NOT_FOUND, 0 observation, KHÔNG degrade nguồn", async () => {
  const { provider, calls } = fakeProvider(async () => null);
  const { useCase, repo, runtime } = harness(provider);

  const result = await useCase.execute({ source: SOURCE, identifier: IDENTIFIER });

  assert.equal(result.status, CollectStatus.NOT_FOUND);
  assert.deepEqual([...result.observations], []);
  assert.equal(repo.size, 0);

  const health = runtime.getHealth(SOURCE);
  assert.equal(health.notFoundCount, 1, "phải đếm vào notFoundCount");
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.failureCount, 0);
  assert.equal(health.state, SourceHealthState.HEALTHY);
  assert.equal(calls(), 1, "NOT_FOUND không được retry");
});

test("nhiều NOT_FOUND liên tiếp vẫn KHÔNG đẩy nguồn vào cooldown", async () => {
  const { provider } = fakeProvider(async () => null);
  const { useCase, runtime } = harness(provider);

  for (let i = 0; i < 10; i += 1) {
    const result = await useCase.execute({ source: SOURCE, identifier: IDENTIFIER });
    assert.equal(result.status, CollectStatus.NOT_FOUND);
  }
  const health = runtime.getHealth(SOURCE);
  assert.equal(health.notFoundCount, 10);
  assert.equal(health.state, SourceHealthState.HEALTHY);
});

test("PARSE_ERROR NÉM ra ngoài, KHÔNG biến thành NOT_FOUND, 0 observation", async () => {
  const { provider, calls } = fakeProvider(async () => {
    throw parseError(SOURCE, "khối JSON nhúng hỏng");
  });
  const { useCase, repo, runtime } = harness(provider);

  await assert.rejects(
    () => useCase.execute({ source: SOURCE, identifier: IDENTIFIER }),
    (err: unknown) => {
      assert.ok(err instanceof SourceRequestError);
      assert.equal(err.category, SourceErrorCategory.PARSE_ERROR);
      return true;
    }
  );

  assert.equal(repo.size, 0);
  assert.equal(calls(), 1, "PARSE_ERROR không retry — tải lại vẫn hỏng y hệt");
  assert.equal(runtime.getHealth(SOURCE).parseErrorCount, 1);
});

test("403 -> BLOCKED, không retry, đếm vào health", async () => {
  const { provider, calls } = fakeProvider(async () => {
    throw Object.assign(new Error("cấm"), { status: 403 });
  });
  const { useCase, runtime } = harness(provider);

  await assert.rejects(() => useCase.execute({ source: SOURCE, identifier: IDENTIFIER }));
  assert.equal(calls(), 1);
  assert.equal(runtime.getHealth(SOURCE).blockedCount, 1);
});

test("hỏng liên tiếp đủ ngưỡng -> COOLDOWN, request sau fail fast", async () => {
  const { provider, calls } = fakeProvider(async () => {
    throw Object.assign(new Error("cấm"), { status: 403 });
  });
  const { useCase, runtime } = harness(provider);

  // Ngưỡng ShipInfo = 3 lần hỏng liên tiếp.
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => useCase.execute({ source: SOURCE, identifier: IDENTIFIER }));
  }
  assert.equal(runtime.getHealth(SOURCE).state, SourceHealthState.COOLDOWN);

  const callsBefore = calls();
  await assert.rejects(
    () => useCase.execute({ source: SOURCE, identifier: IDENTIFIER }),
    /đang hạ nhiệt/
  );
  assert.equal(calls(), callsBefore, "cooldown chặn TRƯỚC khi gọi provider");
});

test("ShipInfo cooldown KHÔNG chặn nguồn khác", async () => {
  const registry = new ProviderRegistry();
  const repo = new InMemoryVesselObservationRepository({ now: () => FETCHED_AT });
  const runtime = new SourceRuntimeManager({ sleep: async () => undefined });

  registry.register({
    source: VesselSource.SHIPINFO,
    async getDetails() {
      throw Object.assign(new Error("cấm"), { status: 403 });
    },
  });
  registry.register({
    source: VesselSource.VESSELFINDER,
    async getDetails() {
      return {
        identity: {
          mmsi: MMSI,
          name: "Từ nguồn khác",
          metadata: createSourceMetadata({
            source: VesselSource.VESSELFINDER,
            fetchedAt: FETCHED_AT,
          }),
        },
      };
    },
  });

  const useCase = new CollectVesselObservations({
    registry,
    runtime,
    recorder: new ObservationRecorder({ repository: repo, now: () => FETCHED_AT }),
  });

  runtime.getHealthTracker(VesselSource.SHIPINFO).enterCooldown(60_000);
  await assert.rejects(() =>
    useCase.execute({ source: VesselSource.SHIPINFO, identifier: IDENTIFIER })
  );

  const other = await useCase.execute({
    source: VesselSource.VESSELFINDER,
    identifier: IDENTIFIER,
  });
  assert.equal(other.status, CollectStatus.RECORDED);
  assert.equal(runtime.getHealth(VesselSource.VESSELFINDER).state, SourceHealthState.HEALTHY);
});

test("ghi lại y hệt trong cửa sổ dedupe -> bị bỏ qua, không nhân bản", async () => {
  const { provider } = fakeProvider(async () => detailsResult());
  const { useCase, repo } = harness(provider);

  const first = await useCase.execute({ source: SOURCE, identifier: IDENTIFIER });
  const second = await useCase.execute({ source: SOURCE, identifier: IDENTIFIER });

  assert.equal(first.observations[0].status, "SAVED");
  assert.equal(second.observations[0].status, "SKIPPED_DUPLICATE");
  assert.equal(repo.size, 1);
});
