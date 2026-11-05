import { fetch } from 'sdk';
import { GEMINI_API_KEY } from './config.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=';

export async function chat(messages) {
  // شخصیت و دستورات برای هوش مصنوعی
  const systemPrompt = "You are a highly professional, engaging, and friendly AI assistant. You must use emojis frequently and appropriately to make the conversation lively. Structure your response beautifully using Markdown formatting (like **bold**, *italic*, and bullet points with -) to make it visually appealing for Telegram. Always reply in the same language the user speaks.";

  const contents = [
    {
      role: 'user',
      parts: [{ text: systemPrompt }]
    },
    {
      role: 'model',
      parts: [{ text: 'I understand. I will be engaging, use emojis, and format my responses beautifully.' }]
    }
  ];

  // اضافه کردن تاریخچه پیام‌ها
  messages.forEach(function(m) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  });

  const res = await fetch(BASE_URL + GEMINI_API_KEY, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ contents: contents })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error('Gemini API Error: ' + res.status + ' - ' + body);
  }

  const data = await res.json();
  
  if (data.candidates && data.candidates.length > 0) {
    return data.candidates[0].content.parts[0].text;
  } else {
    throw new Error('پاسخ نامعتبر از هوش مصنوعی');
  }
}
