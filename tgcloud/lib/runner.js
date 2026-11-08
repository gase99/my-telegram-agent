export async function executeCode(code, language = 'python') {
  const langMap = {
    python: 'python3',
    py: 'python3',
    js: 'javascript',
    javascript: 'javascript',
    bash: 'bash',
    sh: 'bash'
  };
  const targetLang = langMap[language.toLowerCase()] || 'python3';

  try {
    const response = await fetch('https://emkc.org/api/v2/piston/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: targetLang,
        version: '*',
        files: [{ content: code }]
      })
    });
    const data = await response.json();
    if (data.run) {
      return data.run.output || (data.run.stderr ? `Error: ${data.run.stderr}` : 'No output');
    }
    return 'خطا در اجرای کد در محیط مجازی Piston.';
  } catch (err) {
    return `خطای ارتباط با موتور اجرای کد: ${err.message}`;
  }
}
