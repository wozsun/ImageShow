import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { readableFilterSearch, TagFilterError } from "@imageshow/shared/browser";
import { useGalleryFacets } from "../lib/api/site-data.js";
import { galleryFiltersFromSearchParams } from "../lib/gallery/gallery-query.js";

/** The route owns choices; the existing vocabulary query resolves tag references. */
export function useImageBrowseRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const query = params.toString();
  const facetsQuery = useGalleryFacets();
  const parsed = useMemo(() => {
    const current = new URLSearchParams(query);
    try {
      return { filters: galleryFiltersFromSearchParams(current, facetsQuery.data?.tags), error: null };
    } catch (error) {
      if (!(error instanceof TagFilterError)) throw error;
      current.delete("tag");
      return { filters: galleryFiltersFromSearchParams(current), error };
    }
  }, [query, facetsQuery.data]);
  const requiresVocabulary = params.has("tag");
  const error = parsed.error ?? (requiresVocabulary ? facetsQuery.error : null);
  const ready = !error && (!requiresVocabulary || Boolean(facetsQuery.data));
  const linkParams = new URLSearchParams(params);
  if (ready && linkParams.has("tag")) {
    linkParams.delete("tag");
    if (parsed.filters.tag) linkParams.append("tag", parsed.filters.tag);
  }
  const updateSearchParams = useCallback((update: (current: URLSearchParams) => URLSearchParams) => {
    const next = update(new URLSearchParams(query));
    if (facetsQuery.data && next.has("tag")) {
      try {
        const normalized = galleryFiltersFromSearchParams(next, facetsQuery.data.tags);
        next.delete("tag");
        if (normalized.tag) next.append("tag", normalized.tag);
      } catch (error) {
        if (!(error instanceof TagFilterError)) throw error;
      }
    }
    void navigate({ search: readableFilterSearch(next) }, { state: { imageBrowseFilterEdit: true } });
  }, [navigate, query, facetsQuery.data]);
  return {
    params, filters: parsed.filters, error, ready,
    facets: facetsQuery.data, updateSearchParams, browseSearch: readableFilterSearch(linkParams),
    isFilterEdit: location.state?.imageBrowseFilterEdit === true,
    retryVocabulary: () => { void facetsQuery.refetch({ cancelRefetch: false }); }
  };
}
