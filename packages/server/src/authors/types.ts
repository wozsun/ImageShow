// An author mirrors a theme (slug PK + display name) with one extra field: link, an
// optional http(s) URL for the author's page. An image carries a single author
// (metadata.author); unlike theme it does not take part in category keys.
export type Author = {
  slug: string;
  display_name: string;
  link: string;
  image_count: number;
};
