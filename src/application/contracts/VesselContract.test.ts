import assert from "node:assert/strict";
import test from "node:test";
import { NO_DATA, VESSEL_CONTRACT_VERSION, VesselDetails } from "./VesselDetails";
import { toVesselDetails } from "./VesselContractMapper";

test("Vessel contract V1 preserves boundary nullability and portUnlocode spelling", () => {
  const detail: VesselDetails = {
    basics: { vesselName: NO_DATA, mmsi: null, imo: null, vType: null, lat: null, lon: null, course: null, speed: null, navStatus: NO_DATA, received: NO_DATA },
    vesselType: NO_DATA, flag: NO_DATA, grossTonnage: null, deadWeight: null, yearOfBuild: null,
    voyage: {
      current: { port: NO_DATA, portId: null, portUnlocode: NO_DATA, portCountry: NO_DATA, portArrivalUtc: NO_DATA, portArrivalLocal: NO_DATA },
      last: { port: NO_DATA, portId: null, portUnlocode: NO_DATA, portCountry: NO_DATA, portDepartureUtc: NO_DATA, portDepartureLocal: NO_DATA },
      next: { port: NO_DATA, portId: null, portUnlocode: NO_DATA, portCountry: NO_DATA, portEtaUtc: NO_DATA, portEtaLocal: NO_DATA },
    },
  };
  assert.equal(VESSEL_CONTRACT_VERSION, "1");
  assert.equal(detail.voyage.next.portUnlocode, "---");
  assert.equal("portUnloco" in detail.voyage.next, false);
  assert.equal(detail.grossTonnage, null);
  assert.equal(typeof detail.basics.received, "string");
});

test("canonical partial detail maps missing strings to NO_DATA and keeps numeric null", () => {
  const detail = toVesselDetails({
    identifiers: { mmsi: "123456789", imo: null },
    identity: { name: null, vesselType: null, vesselTypeCode: null, flagName: null },
    position: null,
    particulars: { grossTonnage: null, deadweight: null, builtYear: null },
    voyage: { currentPort: null, lastPort: null, nextPort: null },
  });
  assert.equal(detail.basics.vesselName, NO_DATA);
  assert.equal(detail.basics.lat, null);
  assert.equal(detail.grossTonnage, null);
  assert.equal(detail.voyage.next.portUnlocode, NO_DATA);
});
