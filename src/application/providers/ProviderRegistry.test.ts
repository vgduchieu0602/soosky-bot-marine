// ============================================================================
//  TEST · ProviderRegistry — sổ đăng ký, không phải resolver
// ----------------------------------------------------------------------------
//  Provider giả lập ở đây KHÔNG gọi mạng. Điểm cần khoá: registry lọc theo
//  METHOD CÓ TỒN TẠI hay không, và không cho ghi đè im lặng.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { VesselSource } from "../../domain/value-objects/VesselSource";
import { ProviderRegistry } from "./ProviderRegistry";
import {
  ProviderOperation,
  VesselDataProvider,
  getProviderOperations,
  providerSupportsOperation,
} from "./VesselDataProvider";

/** Provider đủ 4 operation. */
function fullProvider(source: VesselSource): VesselDataProvider {
  return {
    source,
    async searchByName() {
      return [];
    },
    async getPosition() {
      return null;
    },
    async getDetails() {
      return null;
    },
    async scanArea() {
      return [];
    },
  };
}

/** Provider chỉ biết tra chi tiết — 3 method còn lại VẮNG MẶT. */
function detailsOnlyProvider(source: VesselSource): VesselDataProvider {
  return {
    source,
    async getDetails() {
      return null;
    },
  };
}

test("register + get + has", () => {
  const registry = new ProviderRegistry();
  const provider = fullProvider(VesselSource.VESSELFINDER);

  assert.equal(registry.has(VesselSource.VESSELFINDER), false);
  assert.equal(registry.get(VesselSource.VESSELFINDER), undefined);

  registry.register(provider);

  assert.equal(registry.has(VesselSource.VESSELFINDER), true);
  assert.equal(registry.get(VesselSource.VESSELFINDER), provider);
  assert.equal(registry.size, 1);
});

test("đăng ký trùng source bị TỪ CHỐI, không ghi đè im lặng", () => {
  const registry = new ProviderRegistry();
  const first = fullProvider(VesselSource.VESSELFINDER);
  registry.register(first);

  assert.throws(
    () => registry.register(detailsOnlyProvider(VesselSource.VESSELFINDER)),
    /đã được đăng ký/
  );
  // Provider đầu tiên vẫn nguyên vẹn.
  assert.equal(registry.get(VesselSource.VESSELFINDER), first);
  assert.equal(registry.size, 1);
});

test("không cho đăng ký provider cho UNKNOWN", () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register(fullProvider(VesselSource.UNKNOWN)), /UNKNOWN/);
  assert.equal(registry.size, 0);
});

test("getAll / getRegisteredSources giữ thứ tự đăng ký", () => {
  const registry = new ProviderRegistry();
  const vesselfinder = fullProvider(VesselSource.VESSELFINDER);
  const shipinfo = detailsOnlyProvider(VesselSource.SHIPINFO);
  registry.register(vesselfinder);
  registry.register(shipinfo);

  assert.deepEqual([...registry.getAll()], [vesselfinder, shipinfo]);
  assert.deepEqual(
    [...registry.getRegisteredSources()],
    [VesselSource.VESSELFINDER, VesselSource.SHIPINFO]
  );
});

test("getForOperation CHỈ trả provider thực sự implement operation đó", () => {
  const registry = new ProviderRegistry();
  const vesselfinder = fullProvider(VesselSource.VESSELFINDER);
  const shipinfo = detailsOnlyProvider(VesselSource.SHIPINFO);
  registry.register(vesselfinder);
  registry.register(shipinfo);

  assert.deepEqual([...registry.getForOperation(ProviderOperation.GET_DETAILS)], [
    vesselfinder,
    shipinfo,
  ]);
  // shipinfo không có method -> bị loại khỏi 3 operation còn lại.
  for (const operation of [
    ProviderOperation.SEARCH_BY_NAME,
    ProviderOperation.GET_POSITION,
    ProviderOperation.SCAN_AREA,
  ]) {
    assert.deepEqual([...registry.getForOperation(operation)], [vesselfinder], operation);
  }
});

test("getAll trả bản sao đóng băng — caller không sửa được registry", () => {
  const registry = new ProviderRegistry();
  registry.register(fullProvider(VesselSource.VESSELFINDER));

  const all = registry.getAll();
  assert.equal(Object.isFrozen(all), true);
  assert.throws(() => {
    (all as VesselDataProvider[]).push(fullProvider(VesselSource.SHIPINFO));
  }, TypeError);
  assert.equal(registry.size, 1);
  assert.equal(Object.isFrozen(registry.getForOperation(ProviderOperation.GET_DETAILS)), true);
});

test("providerSupportsOperation / getProviderOperations đọc chính implementation", () => {
  const shipinfo = detailsOnlyProvider(VesselSource.SHIPINFO);
  assert.equal(providerSupportsOperation(shipinfo, ProviderOperation.GET_DETAILS), true);
  assert.equal(providerSupportsOperation(shipinfo, ProviderOperation.SCAN_AREA), false);
  assert.deepEqual([...getProviderOperations(shipinfo)], [ProviderOperation.GET_DETAILS]);
  assert.equal(getProviderOperations(fullProvider(VesselSource.VESSELFINDER)).length, 4);
});
