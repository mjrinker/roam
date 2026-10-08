import { redirectTo } from "@/lib/tv/http";

/** A short address to type on a TV remote: roam.example/t opens the TV interface. */
export async function GET(request: Request) {
  return redirectTo(request, "/tv");
}
