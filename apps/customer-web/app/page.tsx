import Home from "./home";
// Every HTML response receives its own nonce; never prerender/cache nonce-bearing HTML.
export const dynamic = "force-dynamic";
export default function Page() {
  return <Home />;
}
