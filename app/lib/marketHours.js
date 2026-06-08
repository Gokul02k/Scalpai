export function getMarketStatus(now = new Date()) {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;

  if (day === 0 || day === 6) {
    return { open: false, label: 'Market Closed (Weekend)', detail: 'Opens Mon 9:15 AM IST' };
  }
  if (mins < open) {
    const left = open - mins;
    return { open: false, label: 'Pre-Market', detail: `Opens in ${Math.floor(left / 60)}h ${left % 60}m` };
  }
  if (mins >= close) {
    return { open: false, label: 'Market Closed', detail: 'Opens tomorrow 9:15 AM IST' };
  }
  const left = close - mins;
  return { open: true, label: 'Market Open', detail: `Closes in ${Math.floor(left / 60)}h ${left % 60}m` };
}
