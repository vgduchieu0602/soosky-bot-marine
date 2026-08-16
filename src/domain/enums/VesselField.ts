// ============================================================================
//  DOMAIN · Value Object: VesselField — TỪ VỰNG field theo canonical model
// ----------------------------------------------------------------------------
//  Mỗi giá trị ở đây là MỘT field của canonical model (A1), KHÔNG phải tên
//  field thô của VesselFinder / MyShipTracking / AIS payload. Nhờ vậy source
//  matrix nói được "nguồn X cấp được field Y" mà không lôi schema của nguồn
//  vào domain.
//
//  Value = đúng tên thuộc tính trong interface canonical -> đọc matrix xong
//  biết ngay nó rơi vào field nào, không cần bảng tra thứ hai.
//  Ngoại lệ duy nhất: POSITION_RECEIVED_AT = "positionReceivedAt" trong khi
//  canonical đặt là `VesselPositionReport.receivedAt` — thêm tiền tố để không
//  lẫn với `SourceMetadata.fetchedAt`.
// ============================================================================

/** Nhóm A · Identity (VesselIdentity) */
const IDENTITY_FIELDS = {
  MMSI: "mmsi",
  IMO: "imo",
  NAME: "name",
  CALLSIGN: "callsign",
  VESSEL_TYPE: "vesselType",
  VESSEL_TYPE_CODE: "vesselTypeCode",
  FLAG: "flag",
} as const;

/** Nhóm B · Position (VesselPositionReport) */
const POSITION_FIELDS = {
  LAT: "lat",
  LNG: "lng",
  SPEED: "speed",
  COURSE: "course",
  HEADING: "heading",
  NAV_STATUS: "navStatus",
  POSITION_RECEIVED_AT: "positionReceivedAt",
} as const;

/** Nhóm C · Particulars (VesselParticulars) */
const PARTICULARS_FIELDS = {
  GROSS_TONNAGE: "grossTonnage",
  DEADWEIGHT: "deadweight",
  BUILT_YEAR: "builtYear",
  LENGTH: "length",
  BEAM: "beam",
  DRAUGHT: "draught",
} as const;

/** Nhóm D · Voyage (VesselVoyage) */
const VOYAGE_FIELDS = {
  DESTINATION: "destination",
  ETA: "eta",
  CURRENT_PORT: "currentPort",
  CURRENT_PORT_ARRIVAL_AT: "currentPortArrivalAt",
  NEXT_PORT: "nextPort",
  NEXT_PORT_ETA: "nextPortEta",
  LAST_PORT: "lastPort",
  LAST_PORT_DEPARTURE_AT: "lastPortDepartureAt",
} as const;

export const VesselField = {
  ...IDENTITY_FIELDS,
  ...POSITION_FIELDS,
  ...PARTICULARS_FIELDS,
  ...VOYAGE_FIELDS,
} as const;

export type VesselField = (typeof VesselField)[keyof typeof VesselField];

export const VESSEL_FIELDS: readonly VesselField[] = Object.freeze(
  Object.values(VesselField) as VesselField[]
);

/** Nhóm canonical mà một field thuộc về — dùng để nhóm bảng trong tài liệu/report. */
export const VesselFieldGroup = {
  IDENTITY: "identity",
  POSITION: "position",
  PARTICULARS: "particulars",
  VOYAGE: "voyage",
} as const;

export type VesselFieldGroup = (typeof VesselFieldGroup)[keyof typeof VesselFieldGroup];

const GROUP_BY_FIELD: Readonly<Record<VesselField, VesselFieldGroup>> = Object.freeze({
  ...mapAll(IDENTITY_FIELDS, VesselFieldGroup.IDENTITY),
  ...mapAll(POSITION_FIELDS, VesselFieldGroup.POSITION),
  ...mapAll(PARTICULARS_FIELDS, VesselFieldGroup.PARTICULARS),
  ...mapAll(VOYAGE_FIELDS, VesselFieldGroup.VOYAGE),
} as Record<VesselField, VesselFieldGroup>);

function mapAll(
  group: Record<string, string>,
  value: VesselFieldGroup
): Record<string, VesselFieldGroup> {
  const out: Record<string, VesselFieldGroup> = {};
  for (const field of Object.values(group)) out[field] = value;
  return out;
}

export function getFieldGroup(field: VesselField): VesselFieldGroup {
  return GROUP_BY_FIELD[field];
}

export function getFieldsInGroup(group: VesselFieldGroup): readonly VesselField[] {
  return VESSEL_FIELDS.filter((field) => GROUP_BY_FIELD[field] === group);
}

export function isVesselField(value: unknown): value is VesselField {
  return typeof value === "string" && (VESSEL_FIELDS as readonly string[]).includes(value);
}
