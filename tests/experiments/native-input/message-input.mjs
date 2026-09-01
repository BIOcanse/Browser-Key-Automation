import { pathToFileURL } from 'node:url';
// Reuse the existing reviewed local asset; do not copy a second PostMessage backend.
const { WindowsMessageInput } = await import(pathToFileURL('D:/Code/app debuger for windows/src/runtime/windows/win32-message-input.ts').href);
const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const result = await new WindowsMessageInput().execute(request);
console.log(JSON.stringify(result));
