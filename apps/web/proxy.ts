import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("__Host-jobber_session") || request.cookies.has("jobber_session");
  if (!hasSession) {
    return NextResponse.redirect(new URL("/login?reason=session-expired", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/create/:path*", "/jobs/:path*", "/kits/:path*"],
};
