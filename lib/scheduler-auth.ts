import { createHash, timingSafeEqual } from "node:crypto";

export type SchedulerSecrets = {
  BID_SCHEDULER_SECRET?: string;
  CRON_SECRET?: string;
};

function safeEqual(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function isSchedulerRequest(headers: Headers, secrets: SchedulerSecrets = { BID_SCHEDULER_SECRET: process.env.BID_SCHEDULER_SECRET, CRON_SECRET: process.env.CRON_SECRET }) {
  const schedulerSecret = secrets.BID_SCHEDULER_SECRET?.trim();
  const cronSecret = secrets.CRON_SECRET?.trim();
  const customHeaderSecret = schedulerSecret || cronSecret;
  const customHeader = headers.get("x-bid-scheduler-secret");
  const customHeaderAuthorized = Boolean(customHeaderSecret && customHeader && safeEqual(customHeader, customHeaderSecret));
  const bearerSecret = cronSecret || (!cronSecret ? schedulerSecret : undefined);
  const bearerHeader = headers.get("authorization");
  const bearerAuthorized = Boolean(bearerSecret && bearerHeader && safeEqual(bearerHeader, `Bearer ${bearerSecret}`));
  return customHeaderAuthorized || bearerAuthorized;
}
