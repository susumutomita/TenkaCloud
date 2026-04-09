import type { ParticipantEvent, EventStatus } from '@/lib/api/types';

export interface DevEventRecord extends ParticipantEvent {
  slug: string;
  createdAt: string;
  description?: string;
  organizer?: string;
  eventDate?: string;
  imageUrl?: string;
}

interface DevEventPayload {
  name: string;
  slug?: string;
  description?: string;
  organizer?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  status?: EventStatus;
  imageUrl?: string;
  type?: string;
  timezone?: string;
  participantType?: string;
  cloudProvider?: string;
  regions?: string[];
  scoringType?: string;
  leaderboardVisible?: boolean;
}

interface DevEventUpdate {
  name?: string;
  slug?: string;
  description?: string;
  organizer?: string;
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  status?: EventStatus;
  imageUrl?: string;
}

export function getDevEventStore(): DevEventRecord[] {
  const globalStore = globalThis as typeof globalThis & {
    __TENKACLOUD_DEV_EVENTS__?: DevEventRecord[];
  };
  if (!globalStore.__TENKACLOUD_DEV_EVENTS__) {
    globalStore.__TENKACLOUD_DEV_EVENTS__ = [];
  }
  return globalStore.__TENKACLOUD_DEV_EVENTS__;
}

export function listDevEvents(
  page: number,
  pageSize: number,
  status?: EventStatus | null,
): { events: DevEventRecord[]; total: number; page: number; pageSize: number } {
  const store = getDevEventStore();
  const filtered = status
    ? store.filter((event) => event.status === status)
    : store;
  const offset = Math.max(page - 1, 0) * pageSize;
  return {
    events: filtered.slice(offset, offset + pageSize),
    total: filtered.length,
    page,
    pageSize,
  };
}

export function createDevEvent(body: DevEventPayload): DevEventRecord {
  const now = new Date().toISOString();
  const event: DevEventRecord = {
    id: `dev-event-${Date.now()}`,
    slug: body.slug?.trim() || `event-${Date.now()}`,
    name: body.name,
    description: body.description,
    organizer: body.organizer,
    eventDate: body.eventDate || body.startTime,
    type: (body.type as ParticipantEvent['type']) || 'gameday',
    status: body.status || 'draft',
    startTime: body.startTime || now,
    endTime:
      body.endTime || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    timezone: body.timezone || 'Asia/Tokyo',
    participantType:
      (body.participantType as ParticipantEvent['participantType']) ||
      'individual',
    cloudProvider:
      (body.cloudProvider as ParticipantEvent['cloudProvider']) || 'aws',
    regions: body.regions?.length ? body.regions : ['ap-northeast-1'],
    scoringType:
      (body.scoringType as ParticipantEvent['scoringType']) || 'realtime',
    leaderboardVisible: body.leaderboardVisible ?? true,
    problemCount: 0,
    participantCount: 0,
    isRegistered: false,
    createdAt: now,
    imageUrl: body.imageUrl,
  };
  getDevEventStore().unshift(event);
  return event;
}

export function findDevEvent(eventId: string): DevEventRecord | undefined {
  return getDevEventStore().find((event) => event.id === eventId);
}

export function updateDevEvent(
  eventId: string,
  input: DevEventUpdate,
): DevEventRecord | null {
  const store = getDevEventStore();
  const index = store.findIndex((event) => event.id === eventId);
  if (index === -1) {
    return null;
  }

  const current = store[index];
  const updated: DevEventRecord = {
    ...current,
    ...input,
    slug: input.slug?.trim() || current.slug,
    eventDate: input.eventDate || input.startTime || current.eventDate,
  };
  store[index] = updated;
  return updated;
}

export function deleteDevEvent(eventId: string): boolean {
  const store = getDevEventStore();
  const index = store.findIndex((event) => event.id === eventId);
  if (index === -1) {
    return false;
  }
  store.splice(index, 1);
  return true;
}

export function clearDevEvents() {
  getDevEventStore().length = 0;
}
