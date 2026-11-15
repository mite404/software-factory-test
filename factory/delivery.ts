export type DeliveryIntent = {
  key: string;
  message: string;
  repeated: boolean;
};

/** Validate an optional saved delivery intent without upgrading legacy records. */
export function validDeliveryIntent(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.key === "string" &&
    /^[a-f0-9]{64}$/.test(row.key) &&
    typeof row.message === "string" &&
    row.message.startsWith(`factory-key: ${row.key}\n`) &&
    typeof row.repeated === "boolean"
  );
}
