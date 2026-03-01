import { EventEmitter } from 'events'
import type { BotEvent } from './types.js'

// Typed wrapper around EventEmitter — avoids class-extension TS issues
const emitter = new EventEmitter()
emitter.setMaxListeners(50)

type EventType = BotEvent['type']
type EventData<T extends EventType> = Extract<BotEvent, { type: T }>['data']

export const bus = {
  emit<T extends BotEvent>(event: T): void {
    emitter.emit(event.type, event.data)
  },
  on<T extends EventType>(event: T, listener: (data: EventData<T>) => void): void {
    emitter.on(event, listener as (...args: unknown[]) => void)
  },
  off<T extends EventType>(event: T, listener: (data: EventData<T>) => void): void {
    emitter.off(event, listener as (...args: unknown[]) => void)
  },
  once<T extends EventType>(event: T, listener: (data: EventData<T>) => void): void {
    emitter.once(event, listener as (...args: unknown[]) => void)
  },
}
