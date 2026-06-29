// A tag mirrors a theme (slug PK + display name). The only difference is
// cardinality: an image has many tags but a single theme.
export type Tag = {
  slug: string;
  display_name: string;
  image_count: number;
};
