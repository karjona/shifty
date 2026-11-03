// Main menu content from Postgres: banners and news posts, in the player's
// language only. It lives in the database, so changing it needs no deploy.
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { banner, newsPost } from "./db/schema.ts";
import type { Locale } from "./locale.ts";

export interface BannerView {
  id: number;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  action: string | null;
  theme: string;
}

export interface NewsView {
  slug: string;
  title: string;
  body: string;
  publishedAt: string;
}

const NEWS_LIMIT = 10;

export async function menuContent(db: Db, locale: Locale, now = new Date()) {
  const [banners, news] = await Promise.all([
    db
      .select({
        id: banner.id,
        title: banner.title,
        subtitle: banner.subtitle,
        imageUrl: banner.imageUrl,
        action: banner.action,
        theme: banner.theme,
      })
      .from(banner)
      .where(
        and(
          eq(banner.locale, locale),
          eq(banner.published, true),
          or(isNull(banner.startsAt), lte(banner.startsAt, now)),
          or(isNull(banner.endsAt), gt(banner.endsAt, now)),
        ),
      )
      .orderBy(asc(banner.sort), asc(banner.id)),
    db
      .select({ slug: newsPost.slug, title: newsPost.title, body: newsPost.body, publishedAt: newsPost.publishedAt })
      .from(newsPost)
      .where(and(eq(newsPost.locale, locale), isNotNull(newsPost.publishedAt), lte(newsPost.publishedAt, now)))
      .orderBy(desc(newsPost.publishedAt))
      .limit(NEWS_LIMIT),
  ]);
  return {
    banners: banners satisfies BannerView[],
    news: news.map((n): NewsView => ({
      slug: n.slug,
      title: n.title,
      body: n.body,
      publishedAt: (n.publishedAt ?? now).toISOString(),
    })),
  };
}
