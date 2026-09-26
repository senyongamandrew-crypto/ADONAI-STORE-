import { body, fail, ok } from "@/lib/http";
import { beginAuthentication } from "@/lib/passkey";

export const dynamic = "force-dynamic";

/** Anonymous: starts a passkey sign-in. `email` is optional. */
export async function POST(req: Request) {
  try {
    const { email } = await body<{ email?: string }>(req).catch(() => ({ email: undefined }));
    const { options, rpID } = await beginAuthentication(req, email);
    return ok({ options, rpID });
  } catch (e) {
    const err = e as Error & { status?: number };
    return fail(err.message, err.status ?? 400);
  }
}
