import { chat } from '../lib/beatapi.js';

export default async function (input, ctx) {
  const prompt = input.prompt;
  
  if (!prompt) {
    return { output: "Error: No prompt provided." };
  }

  // دادن شخصیت ترمینال و برنامه‌نویس به هوش مصنوعی
  const systemContext = [
    { role: 'user', content: "You are an advanced AI coding agent running in a Linux terminal. Answer concisely. If you write code, format it properly. Do NOT use markdown block ticks (```), just output the raw text so it looks like a real terminal response." }
  ];

  // اضافه کردن دستور کاربر
  systemContext.push({ role: 'user', content: prompt });

  try {
    const response = await chat(systemContext);
    return { output: response };
  } catch (e) {
    return { output: "System Error: " + e.message };
  }
}
