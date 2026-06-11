export function formatDashboardJoinUrl(clientOrigin: string, peerId: string): string {
  const origin = clientOrigin.replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('host', peerId);
  // Trailing slash is required: the Vite multi-page build mounts the dashboard
  // at the directory route, so `/dashboard#...` serves the marketing page.
  return `${origin}/dashboard/#${params.toString()}`;
}
