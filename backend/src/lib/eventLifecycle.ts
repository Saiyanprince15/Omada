import { AppError } from '../middleware/errorHandler';

export type EventStatusValue =
  | 'draft'
  | 'registration_open'
  | 'registration_closed'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export function assertEventRegistrationOpen(status: string): void {
  if (status !== 'registration_open') {
    throw new AppError(409, 'REGISTRATION_CLOSED', 'Event registration is not open.');
  }
}

export function assertEventFormationOpen(status: string): void {
  if (!['registration_open', 'registration_closed', 'in_progress'].includes(status)) {
    throw new AppError(409, 'EVENT_NOT_ACTIVE', 'Team formation is not available for this event.');
  }
}

export function assertEventMatchmakingOpen(status: string): void {
  if (!['registration_open', 'registration_closed', 'in_progress'].includes(status)) {
    throw new AppError(409, 'MATCHMAKING_CLOSED', 'Matchmaking is not available for this event.');
  }
}

export function assertEventIsActive(status: string): void {
  if (['completed', 'cancelled'].includes(status)) {
    throw new AppError(409, 'EVENT_INACTIVE', 'This event is no longer active.');
  }
}
