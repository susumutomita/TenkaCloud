/** CloudFormation can remove a partial stack without application outputs or control-data reads. */
export interface PlatformStack {
  readonly name: string;
  readonly arn: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly status: string;
}
export function canRecoverCreation(status: string): boolean {
  return [
    "CREATE_FAILED",
    "ROLLBACK_FAILED",
    "ROLLBACK_COMPLETE",
    "DELETE_FAILED",
    "DELETE_IN_PROGRESS",
  ].includes(status);
}
