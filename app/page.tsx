"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

type Status = "draft" | "approved" | "completed";
type ImageItem = { id: string; src: string; name: string };
type Listing = {
  id: string;
  ebayUrl: string;
  title: string;
  description: string;
  price: number;
  status: Status;
  finalPrice?: number;
  buyer?: string;
  completedAt?: string;
  images: ImageItem[];
};

const demoImages = [
  "https://images.unsplash.com/photo-1566454419290-57a7c7d2d8d9?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1599707367072-cd6ada2bc375?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85",
];

const initialListings: Listing[] = [
  {
    id: "K-104",
    ebayUrl: "https://www.ebay.com/itm/166824019402",
    title: "Faca artesanal com cabo em madeira â€” conforme fotos",
    description: "PeÃ§a artesanal com lÃ¢mina de perfil robusto e cabo em madeira. O item apresenta sinais compatÃ­veis com o uso e a idade, conforme mostrado nas fotos. Uma opÃ§Ã£o interessante para colecionadores e apreciadores de cutelaria. Observe atentamente todas as imagens antes de participar do leilÃ£o.",
    price: 450,
    status: "approved",
    images: demoImages.map((src, i) => ({ id: `k104-${i}`, src, name: `${i + 1}.jpg` })),
  },
  {
    id: "K-103",
    ebayUrl: "https://www.ebay.com/itm/166824019401",
    title: "Canivete vintage com acabamento escuro",
    description: "Canivete com acabamento escuro e desenho clÃ¡ssico. A condiÃ§Ã£o geral pode ser conferida nas fotos, que fazem parte da descriÃ§Ã£o. Item vendido no estado em que se encontra.",
    price: 280,
    status: "draft",
    images: demoImages.slice(1).map((src, i) => ({ id: `k103-${i}`, src, name: `${i + 1}.jpg` })),
  },
  {
    id: "K-098",
    ebayUrl: "https://www.ebay.com/itm/166824019399",
    title: "Lote de duas peÃ§as de cutelaria",
    description: "Lote com duas peÃ§as de cutelaria em condiÃ§Ãµes visÃ­veis nas fotografias. InformaÃ§Ãµes nÃ£o confirmadas sobre origem e material; veja as imagens para avaliar os detalhes.",
    price: 190,
    status: "completed",
    finalPrice: 360,
    buyer: "Marcos Almeida",
    completedAt: "31 JUL 2026",
    images: demoImages.slice(0, 2).map((src, i) => ({ id: `k098-${i}`, src, name: `${i + 1}.jpg` })),
  },
];

const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const parsePrice = (value: string) => Number(value.replace(/[^0-9,.-]/g, "").replace(/\./g, "").replace(",", ".")) || 0;

export default function Home() {
  const [unlocked, setUnlocked] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(true);
  const [password, setPassword] = useState("");
  const [accessError, setAccessError] = useState("");
  const [role, setRole] = useState<"staff" | "auctioneer">("staff");
  const [language, setLanguage] = useState<"pt" | "en">("pt");
  const [listings, setListings] = useState(initialListings);
  const [section, setSection] = useState<Status>("draft");
  const [selected, setSelected] = useState<Listing | null>(null);
  const [links, setLinks] = useState("");
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [completion, setCompletion] = useState<Listing | null>(null);

  const visible = useMemo(() => listings.filter((l) => l.status === (role === "auctioneer" ? "approved" : section)), [listings, role, section]);

  const updateListing = (next: Listing) => setListings((all) => all.map((l) => l.id === next.id ? next : l));
  const importListings = async () => {
    const requestedLinks = links.split(/\s+/).filter(Boolean);
    if (!requestedLinks.length) { setNotice(en ? "Paste at least one eBay link." : "Cole pelo menos um link do eBay."); return; }
    setImporting(true); setNotice("");
    try {
      const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ links: requestedLinks.join("\n") }) });
      const payload = await response.json();
      const successful = (payload.results || []).filter((result: { ok: boolean }) => result.ok);
      const failed = (payload.results || []).filter((result: { ok: boolean }) => !result.ok);
      const created: Listing[] = successful.map((result: { url: string; itemId: string; title: string; description: string; imageUrls?: string[] }, index: number) => ({ id: `K-${result.itemId || Date.now() + index}`, ebayUrl: result.url, title: result.title, description: result.description, price: 0, status: "draft", images: (result.imageUrls || []).map((src, imageIndex) => ({ id: `${result.itemId}-${imageIndex}`, src, name: `${String(imageIndex + 1).padStart(2, "0")}.jpg` })) }));
      setListings((all) => [...created, ...all]); setLinks("");
      const successMessage = en ? `${successful.length} item(s) imported as draft.` : `${successful.length} item(ns) importado(s) como rascunho.`;
      const failureMessage = failed.length ? ` ${failed.length} ${en ? "link(s) failed." : "link(s) falharam."}` : "";
      setNotice(successMessage + failureMessage);
    } catch {
      setNotice(en ? "Could not connect to the import service." : "NÃ£o foi possÃ­vel conectar ao serviÃ§o de importaÃ§Ã£o.");
    } finally { setImporting(false); }
  };

  const copy = async (text: string, message: string) => { await navigator.clipboard?.writeText(text); setNotice(message); window.setTimeout(() => setNotice(""), 1800); };
  const complete = () => { if (!completion) return; const price = parsePrice((document.getElementById("final-price") as HTMLInputElement)?.value || ""); const buyer = (document.getElementById("buyer") as HTMLInputElement)?.value.trim(); if (price < 0 || !buyer) { setNotice("Informe o valor final e o nome do comprador."); return; } updateListing({ ...completion, status: "completed", finalPrice: price, buyer }); setCompletion(null); setNotice("LeilÃ£o concluÃ­do."); };

  const en = language === "en";
  useEffect(() => {
    fetch("/api/access").then((response) => setUnlocked(response.ok)).catch(() => setUnlocked(false)).finally(() => setCheckingAccess(false));
  }, []);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    setAccessError("");
    const response = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    if (response.ok) { setUnlocked(true); setPassword(""); } else setAccessError(en ? "Incorrect password." : "Senha incorreta.");
  };

  if (checkingAccess) return <main className="access-screen"><div className="access-card"><span className="brand-mark">âœ¦</span><p className="muted">Loadingâ€¦</p></div></main>;
  if (!unlocked) return <main className="access-screen"><form className="access-card" onSubmit={unlock}><span className="brand-mark">âœ¦</span><strong>Fio & LÃ¢mina</strong><p className="muted">{en ? "Enter the team password to continue." : "Digite a senha da equipe para continuar."}</p><label>{en ? "Password" : "Senha"}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>{accessError && <p className="access-error">{accessError}</p>}<button className="primary large" type="submit">{en ? "Enter" : "Entrar"}</button></form></main>;

  if (selected) return <Editor listing={selected} language={language} onBack={() => setSelected(null)} onSave={(next) => { updateListing(next); setSelected(null); setNotice(en ? "Draft saved." : "Rascunho salvo."); }} onDelete={() => { setListings((all) => all.filter((l) => l.id !== selected.id)); setSelected(null); }} />;

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">âœ¦</span><div><strong>Fio & LÃ¢mina</strong><small>{en ? "Auction preparation" : "PreparaÃ§Ã£o de leilÃµes"}</small></div></div><div className="role-switch"><button className={role === "staff" ? "active" : ""} onClick={() => setRole("staff")}>{en ? "Staff" : "Equipe"}</button><button className={role === "auctioneer" ? "active" : ""} onClick={() => setRole("auctioneer")}>{en ? "Auctioneer" : "Leiloeiro"}</button></div><div className="language-switch" aria-label="Language"><button className={language === "pt" ? "active" : ""} onClick={() => setLanguage("pt")}>PT</button><button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>EN</button></div><button className="avatar" aria-label={en ? "Log out" : "Sair"}>AM</button></header>
    {role === "staff" ? <>
      <section className="welcome"><div><p className="eyebrow">{en ? "STAFF PANEL" : "PAINEL DA EQUIPE"}</p><h1>{en ? "Prepare the next auction." : "Prepare o prÃ³ximo leilÃ£o."}</h1><p className="muted">{en ? "Import your items, review the text, and send them to the auctioneer." : "Importe seus itens, revise o texto e envie para o leiloeiro."}</p></div><div className="date-pill">01 AUG <span>2026</span></div></section>
      <section className="import-card"><div className="section-heading"><div><span className="step">01</span><div><h2>{en ? "Import items" : "Importar itens"}</h2><p>{en ? "Paste one or more eBay links, one per line." : "Cole um ou mais links do eBay, um por linha."}</p></div></div></div><textarea value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://www.ebay.com/itm/..." aria-label={en ? "Paste eBay links" : "Cole eBay links"} /><div className="import-actions"><span className="hint">{en ? "Original text and photos will be imported for your review." : "O texto original e as fotos serÃ£o importados para sua revisÃ£o."}</span><button className="primary" onClick={importListings} disabled={importing}>{importing ? (en ? "Importingâ€¦" : "Importandoâ€¦") : (en ? "Import listings  â†’" : "Importar listings  â†’")}</button></div></section>
      {notice && <div className="notice">{notice}</div>}
      <section className="listing-section"><div className="section-title"><div><p className="eyebrow">{en ? "YOUR ITEMS" : "SEUS ITENS"}</p><h2>Listings</h2></div><div className="tabs">{(["draft", "approved", "completed"] as Status[]).map((s) => <button key={s} className={section === s ? "active" : ""} onClick={() => setSection(s)}>{s === "draft" ? (en ? "Drafts" : "Rascunhos") : s === "approved" ? (en ? "Approved" : "Aprovados") : (en ? "Completed" : "ConcluÃ­dos")}<b>{listings.filter((l) => l.status === s).length}</b></button>)}</div></div><div className={section === "completed" ? "completed-list" : "listing-grid"}>{visible.map((listing) => section === "completed" ? <CompletedRow key={listing.id} listing={listing} language={language} /> : <StaffCard key={listing.id} listing={listing} onClick={() => setSelected(listing)} language={language} />)}{visible.length === 0 && <div className="empty">{en ? "No items in this section." : "Nenhum item nesta seÃ§Ã£o."}</div>}</div></section>
    </> : <Auctioneer listings={visible} language={language} onComplete={setCompletion} onCopy={copy} notice={notice} />}
    {completion && <div className="modal-backdrop"><div className="modal"><button className="close" onClick={() => setCompletion(null)}>Ã—</button><p className="eyebrow">ENCERRAR LEILÃƒO</p><h2>{completion.title}</h2><label>Valor final de venda<input id="final-price" inputMode="decimal" placeholder="R$ 0,00" /></label><label>Nome do comprador<input id="buyer" placeholder="Nome completo" /></label><div className="modal-actions"><button onClick={() => setCompletion(null)}>Cancelar</button><button className="primary" onClick={complete}>Concluir leilÃ£o</button></div></div></div>}
  </main>;
}

function StaffCard({ listing, onClick, language }: { listing: Listing; onClick: () => void; language: "pt" | "en" }) { const en = language === "en"; return <button className="listing-card" onClick={onClick}><img src={listing.images[0]?.src} alt="" /><div className="card-copy"><div className="status-line"><span className={`dot ${listing.status}`} />{listing.status === "draft" ? (en ? "Draft" : "Rascunho") : listing.status === "approved" ? (en ? "Approved" : "Aprovado") : (en ? "Completed" : "ConcluÃ­do")}</div><h3>{listing.title}</h3>{listing.status === "completed" ? <p className="result">{money(listing.finalPrice || 0)} Â· {listing.buyer}</p> : <strong className="price">{money(listing.price)}</strong>}</div><span className="arrow">â†—</span></button>; }

function CompletedRow({ listing, language }: { listing: Listing; language: "pt" | "en" }) { const en = language === "en"; return <div className="completed-row"><div className="completed-item"><span className="dot completed" /><strong>{listing.title}</strong></div><div><small>{en ? "Date" : "Data"}</small><span>{listing.completedAt || "â€”"}</span></div><div><small>{en ? "Final sale" : "Venda final"}</small><span>{money(listing.finalPrice || 0)}</span></div><div><small>{en ? "Buyer" : "Comprador"}</small><span>{listing.buyer || "â€”"}</span></div></div>; }

function Editor({ listing, language, onBack, onSave, onDelete }: { listing: Listing; language: "pt" | "en"; onBack: () => void; onSave: (l: Listing) => void; onDelete: () => void }) { const en = language === "en"; const [draft, setDraft] = useState(listing); const [drag, setDrag] = useState<number | null>(null); return <main className="editor-page"><button className="back" onClick={onBack}>â† {en ? "Back to listings" : "Voltar para listings"}</button><div className="editor-head"><div><p className="eyebrow">{en ? "EDIT LISTING" : "EDITAR LISTING"}</p><h1>{draft.id}</h1></div><a href={draft.ebayUrl} target="_blank">{en ? "View original listing â†—" : "Ver anÃºncio original â†—"}</a></div><div className="editor-layout"><section className="editor-main"><div className="panel"><label>{en ? "Title" : "TÃ­tulo"}<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label><label>{en ? "Description" : "DescriÃ§Ã£o"}<textarea className="description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label><label>{en ? "Starting-closing price" : "ComeÃ§ar fechamento em"}<input value={draft.price ? draft.price.toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : ""} onChange={(e) => setDraft({ ...draft, price: parsePrice(e.target.value) })} inputMode="decimal" placeholder="R$ 0,00" /></label></div><div className="panel"><div className="panel-heading"><div><p className="eyebrow">{en ? "PHOTOS" : "FOTOS"}</p><h2>{draft.images.length} {en ? "images" : "imagens"}</h2></div><label className="upload">+ {en ? "Add" : "Adicionar"}<input type="file" accept="image/*" multiple onChange={(e) => { const files = Array.from(e.target.files || []); setDraft({ ...draft, images: [...draft.images, ...files.map((f, i) => ({ id: `upload-${Date.now()}-${i}`, src: URL.createObjectURL(f), name: f.name }))] }); }} /></label></div><div className="photo-grid">{draft.images.map((img, i) => <div key={img.id} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag === null) return; const images = [...draft.images]; const [moved] = images.splice(drag, 1); images.splice(i, 0, moved); setDraft({ ...draft, images }); setDrag(null); }} className={`photo ${i === 0 ? "primary-photo" : ""}`}><img src={img.src} alt="" /><button onClick={() => setDraft({ ...draft, images: draft.images.filter((x) => x.id !== img.id) })}>Ã—</button>{i === 0 && <span>{en ? "Primary" : "Principal"}</span>}</div>)}</div><p className="drag-hint">{en ? "Drag photos to reorder. The first will be the primary image." : "Arraste as fotos para reordenar. A primeira serÃ¡ a principal."}</p></div></section><aside className="editor-actions"><button className="primary large" onClick={() => onSave(draft)}>{en ? "Save draft" : "Salvar rascunho"}</button>{draft.status === "draft" && <button className="approve" disabled={!draft.title.trim() || !draft.description.trim() || draft.price <= 0 || draft.images.length === 0} onClick={() => onSave({ ...draft, status: "approved" })}>{en ? "Approve and send â†’" : "Aprovar e enviar â†’"}</button>}<button className="danger" onClick={onDelete}>{en ? "Delete" : "Excluir"}</button><p className="validation">{en ? "To approve: title, description, price above zero, and at least one photo." : "Para aprovar: tÃ­tulo, descriÃ§Ã£o, preÃ§o maior que zero e pelo menos uma foto."}</p></aside></div></main>; }

function Auctioneer({ listings, language, onComplete, onCopy, notice }: { listings: Listing[]; language: "pt" | "en"; onComplete: (l: Listing) => void; onCopy: (text: string, message: string) => void; notice: string }) { const en = language === "en"; return <main className="auctioneer-page"><section className="auctioneer-hero"><p className="eyebrow">{en ? "AUCTIONEER AREA" : "ÃREA DO LEILOEIRO"}</p><h1>{en ? "Ready for WhatsApp." : "Prontos para o WhatsApp."}</h1><p className="muted">{en ? "Copy the information, download the photos, and publish manually." : "Copie as informaÃ§Ãµes, baixe as fotos e publique manualmente."}</p></section>{notice && <div className="notice">{notice}</div>}<div className="auction-list">{listings.map((l) => { const text = `${l.title}\n\n${en ? "Starting-closing price" : "ComeÃ§ar fechamento em"}: ${money(l.price)}\n\n${l.description}`; return <article className="auction-card" key={l.id}><div className="auction-photos">{l.images.map((img, index) => <a className="photo-download" href={img.src} download={img.name} key={img.id}><img src={img.src} alt={en ? "Item photo" : "Foto do item"} /><span>{en ? `Download JPEG ${String(index + 1).padStart(2, "0")}` : `Baixar JPEG ${String(index + 1).padStart(2, "0")}`}</span></a>)}</div><div className="auction-body"><h2>{l.title}</h2><p className="auction-price">{en ? "Starting-closing price:" : "ComeÃ§ar fechamento em:"} <strong>{money(l.price)}</strong></p><p className="auction-description">{l.description}</p><div className="auction-actions"><button onClick={() => onCopy(l.title, en ? "Title copied." : "TÃ­tulo copiado.")}>{en ? "Copy title" : "Copiar tÃ­tulo"}</button><button onClick={() => onCopy(l.description, en ? "Description copied." : "DescriÃ§Ã£o copiada.")}>{en ? "Copy description" : "Copiar descriÃ§Ã£o"}</button><button className="primary" onClick={() => onCopy(text, en ? "Complete text copied." : "Texto completo copiado.")}>{en ? "Copy complete text" : "Copiar texto completo"}</button><button className="complete" onClick={() => onComplete(l)}>{en ? "Complete auction" : "Concluir leilÃ£o"}</button></div></div></article>})}{listings.length === 0 && <div className="empty">{en ? "No approved auctions right now." : "Nenhum leilÃ£o aprovado no momento."}</div>}</div></main>; }
