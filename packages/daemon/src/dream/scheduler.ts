import cron, { type ScheduledTask } from 'node-cron';

/**
 * Schedules Dream Mode to fire at 2:00 AM in the user's local timezone.
 * The returned task handle can be stopped on graceful shutdown.
 */
export function scheduleDreamMode(
  triggerDream: () => void,
  timezone: string,
): ScheduledTask {
  return cron.schedule('0 2 * * *', triggerDream, { timezone });
}
