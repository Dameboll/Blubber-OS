import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Blubber — Claude OS',
  description: 'Local agentic command deck — real Claude Code sessions behind a 3D shell.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
