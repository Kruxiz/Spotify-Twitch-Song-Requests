document.getElementById('refresh').onclick = async () => {
    const res = await fetch('/api/current-track');
    const data = await res.json();
    document.getElementById('current-track').textContent = data.track || 'Nothing playing';
  };
  
  document.getElementById('refundsToggle').onchange = async (e) => {
    await fetch('/api/bot-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refunds_enabled: e.target.checked })
    });
  };
  