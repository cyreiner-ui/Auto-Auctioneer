import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Fio & Lâmina · Preparação de leilões", description: "Prepare listings para o seu próximo leilão." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body>{children}</body></html>; }
