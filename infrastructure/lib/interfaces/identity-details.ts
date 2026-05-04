export interface IdentityDetails {
  name: string;
  details: {
    [key: string]: unknown;
  };
}
