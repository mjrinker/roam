import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";

/** Folder-picker data source — lists a server's own Box folder's children. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  const folderId = searchParams.get("folderId") ?? "0"; // Box's root folder id

  if (!serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const member = await getCurrentServerAdmin(serverId);
  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const provider = createBoxProviderForServer(serverId);
    const entries = await provider.listFolder(folderId);
    const folders = entries
      .filter((e) => e.kind === "folder")
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ folders });
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) {
      return NextResponse.json(
        { error: "This server's Box connection needs to be reconnected." },
        { status: 424 }
      );
    }
    return NextResponse.json({ error: "Failed to browse that Box folder." }, { status: 500 });
  }
}
