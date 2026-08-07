import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "auctioneer_staff_access";
const SESSION_CONTEXT = "auctioneer-staff-session";

export function safeEqual(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function staffSessionToken(password: string) {
  return createHmac("sha256", password).update(SESSION_CONTEXT).digest("hex");
}

export async function isStaffRequest(request?: Request) {
  const expected = process.env.APP_STAFF_PASSWORD;
  if (!expected) return false;
  const sessionToken = staffSessionToken(expected);
  const token = request?.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.split("=")[1];
  if (token) return safeEqual(token, sessionToken);
  const store = await cookies();
  const stored = store.get(COOKIE_NAME)?.value;
  return Boolean(stored) && safeEqual(stored!, sessionToken);
}

export async function requireStaff(request?: Request) {
  return isStaffRequest(request);
}

export { COOKIE_NAME };
