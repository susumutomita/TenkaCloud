/** Legacy organizer-password port; implementations must preserve stored hash compatibility. */
export interface OrganizerPasswords {
  hash(value: string): Promise<string>;
  verify(value: string, hash: string): Promise<boolean>;
}
