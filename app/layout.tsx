import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Knife Auctions · Auction preparation", description: "Prepare listings for your next auction." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body>{children}</body></html>; }
