import { NextResponse } from "next/server";
import { COOKIE_NAME, safeEqual, staffSessionToken } from "@/lib/staff-auth";

export async function GET(request: Request) {
  const expected = process.env.APP_STAFF_PASSWORD;
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + "="))?.split("=")[1];
  const ok = Boolean(expected && token && safeEqual(token, staffSessionToken(expected)));
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false }, { status: 401 });
}

export async function POST(request: Request) {
  const { password } = await request.json().catch(() => ({ password: "" }));
  const expected = process.env.APP_STAFF_PASSWORD;
  if (!expected || typeof password !== "string" || !safeEqual(password, expected)) return NextResponse.json({ ok: false }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, staffSessionToken(expected), { httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 30, path: "/" });
  return response;
}
