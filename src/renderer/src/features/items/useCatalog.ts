import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

/** Reference data for item forms/lists (category axes, purities, locations).
 * Cached for the session — it changes rarely. */
export function useCatalog() {
  return useQuery({
    queryKey: ['catalog', 'all'],
    queryFn: () => api['catalog.all']({}),
    staleTime: 5 * 60 * 1000,
  });
}
