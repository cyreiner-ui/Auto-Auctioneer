export type SchedulerSecrets = {
  BID_SCHEDULER_SECRET?: string;
  CRON_SECRET?: string;
};

export function isSchedulerRequest(headers: Headers, secrets: SchedulerSecrets = { BID_SCHEDULER_SECRET: process.env.BID_SCHEDULER_SECRET, CRON_SECRET: process.env.CRON_SECRET }) {
  const schedulerSecret = secrets.BID_SCHEDULER_SECRET?.trim();
  const cronSecret = secrets.CRON_SECRET?.trim();
  const customHeaderSecret = schedulerSecret || cronSecret;
  const customHeaderAuthorized = Boolean(customHeaderSecret && headers.get("x-bid-scheduler-secret") === customHeaderSecret);
  const bearerSecret = cronSecret || (!cronSecret ? schedulerSecret : undefined);
  const bearerAuthorized = Boolean(bearerSecret && headers.get("authorization") === `Bearer ${bearerSecret}`);
  return customHeaderAuthorized || bearerAuthorized;
}
