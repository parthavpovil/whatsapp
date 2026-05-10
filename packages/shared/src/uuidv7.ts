import { uuidv7 as raw } from 'uuidv7';
import type { EventId } from './types/ids.js';

export const uuidv7 = (): string => raw();

export const newEventId = (): EventId => raw() as EventId;
