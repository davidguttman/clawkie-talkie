export function formatDashboardJoinUrl(clientOrigin: string, peerId: string): string {
  const origin = clientOrigin.replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('host', peerId);
  return `${origin}/dashboard#${params.toString()}`;
}
