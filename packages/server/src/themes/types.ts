// A theme mirrors a tag (slug PK + display name). The only difference is
// cardinality: an image has a single theme but many tags.
export type Theme = {
  slug: string;
  display_name: string;
  image_count: number;
};
