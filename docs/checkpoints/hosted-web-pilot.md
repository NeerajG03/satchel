# Hosted web pilot

Verified 11 September 2026.

- Production: https://satchel-pi.vercel.app
- Vercel project: https://vercel.com/neerajg03s-projects/satchel
- Private repository: https://github.com/NeerajG03/satchel
- Deployed application commit: `d6f805dad1802774edd1da37bda00ed8b5779d57`.
- Deployment ID: `dpl_CTKy78JMU1d66njRRoFh1DEcn2hK`.

The initial import reported that the repository could not be found. GitHub's existing Vercel installation already allowed all repositories. Connecting GitHub again from Vercel's import page made Satchel appear in the repository picker, and retrying the original configured import succeeded. No GitHub installation permission changes were required.

Vercel uses the repository's Vite build configuration and the two public Supabase environment variables. Supabase's Site URL is now `https://satchel-pi.vercel.app`; the redirect allow list contains that exact origin and `http://127.0.0.1:5173`. No preview-domain wildcard was added. GitHub's OAuth callback remains the Supabase callback.

## Browser verification

- Production landing page loads.
- GitHub sign-in returns to the production origin and loads the existing account's project list.
- A temporary personal memory saves and survives a full browser reload.
- More info loads on demand with the expected content.
- Deletion succeeds and the temporary entry is removed.

Existing user records were not modified. The broader correction, isolation and scope checks are recorded in [web-memory-pilot-2](web-memory-pilot-2.md); they were not all repeated on production during this deployment check.

On 11 September 2026, the user confirmed signing in and using Satchel on their phone. This completes the independent-device smoke check for the web foundation milestone; specific phone CRUD, recovery and offboarding scenarios were not separately reported.

Native agent authentication, hooks and plugins remain subsequent work; hosting the web companion does not implement those integrations.
