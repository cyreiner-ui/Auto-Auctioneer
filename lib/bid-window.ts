export const ACTIVE_BID_PAGE_SIZE = 100;

const activeBidSelection = "id, title, ebay_item_id, ebay_url, max_bid, currency, bid_window_start, bid_window_end, account_id, execution_mode, ebay_accounts(id, marketplace, refresh_token_ciphertext)";

type Query = {
  select: (selection: string) => Query;
  eq: (column: string, value: string) => Query;
  lte: (column: string, value: string) => Query;
  gte: (column: string, value: string) => Query;
  order: (column: string, options: { ascending: boolean }) => Query;
  range: (from: number, to: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
};

type QueryClient = { from: (table: string) => unknown };

export async function listActiveBidLots(client: QueryClient, now: string) {
  const lots: unknown[] = [];
  let offset = 0;

  while (true) {
    const query = client.from("bid_lots") as Query;
    const { data, error } = await query
      .select(activeBidSelection)
      .eq("status", "armed")
      .lte("bid_window_start", now)
      .gte("bid_window_end", now)
      .order("id", { ascending: true })
      .range(offset, offset + ACTIVE_BID_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    lots.push(...page);
    if (page.length < ACTIVE_BID_PAGE_SIZE) break;
    offset += ACTIVE_BID_PAGE_SIZE;
  }

  return lots;
}
