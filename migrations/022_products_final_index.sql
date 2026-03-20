CREATE INDEX IF NOT EXISTS products_final_article_size_price_idx
  ON products_final (article, size, price_final);
