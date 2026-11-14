try {
  const saved = localStorage.getItem("ensemble.docs.theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch { /* A blocked preference store still follows the system theme. */ }
