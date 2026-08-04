import { cookies } from "next/headers";

const COOKIE_NAME = "auctioneer_staff_access";

export async function isStaffRequest(request?: Request) {
  const expected = process.env.APP_STAFF_PASSWORD;
  if (!expected) return false;
  const token = request?.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.split("=")[1];
  if (token) return token === expected;
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value === expected;
}

export async function requireStaff(request?: Request) {
  return isStaffRequest(request);
}
