/**
 * Activity types for system event tracking
 */

export type ActivityAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'ACCESS';

export type ActivityResourceType =
  | 'USER'
  | 'TENANT'
  | 'BATTLE'
  | 'PROBLEM'
  | 'SETTING'
  | 'SYSTEM';

export interface Activity {
  id: string;
  action: ActivityAction;
  resourceType: ActivityResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface ActivitiesResponse {
  data: Activity[];
  pagination: {
    limit: number;
    hasNextPage: boolean;
  };
}
