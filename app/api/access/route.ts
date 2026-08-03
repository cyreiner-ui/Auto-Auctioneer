import { NextResponse } from "next/server";

const COOKIE_NAME = "auctioneer_access";

export async function GET(request: Request) {
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.split("=")[1];
  return token === process.env.APP_PASSWORD ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false }, { status: 401 });
}

export async function POST(request: Request) {
  const { password } = await request.json().catch(() => ({ password: "" }));
  if (!process.env.APP_PASSWORD || password !== process.env.APP_PASSWORD) return NextResponse.json({ ok: false }, { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, process.env.APP_PASSWORD, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 30, path: "/" });
  return response;
}
