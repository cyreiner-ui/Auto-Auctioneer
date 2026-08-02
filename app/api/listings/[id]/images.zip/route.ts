import JSZip from "jszip";
import { NextResponse } from "next/server";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) { const zip = new JSZip(); const urls = ["https://images.unsplash.com/photo-1566454419290-57a7c7d2d8d9?auto=format&fit=crop&w=900&q=85"]; for (let i = 0; i < urls.length; i++) { const response = await fetch(urls[i]); if (response.ok) zip.file(`${String(i + 1).padStart(2, "0")}.jpg`, await response.arrayBuffer()); } return new NextResponse(await zip.generateAsync({ type: "arraybuffer" }), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="fotos-${(await params).id}.zip"` } }); }

