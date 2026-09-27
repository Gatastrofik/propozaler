import { NormalizedOpportunitySchema, type NormalizedOpportunity } from "../src/model/opportunity.js";

export const NOW = "2026-09-27T11:00:00Z";

export function sampleNormalized(over: Partial<NormalizedOpportunity> = {}): NormalizedOpportunity {
  return NormalizedOpportunitySchema.parse({
    id: "crol:20260909003",
    source: "crol",
    source_id: "20260909003",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260909003",
    title: "Brooklyn Bridge Park Pier 1 Pavilion Stair Replacement",
    notice_type: "solicitation",
    notice_type_raw: "Solicitation",
    agency: "Brooklyn Bridge Park",
    agency_path: "City of New York > Brooklyn Bridge Park",
    buyer_level: "authority",
    place: { state: "NY", city: "New York" },
    posted_at: "2026-09-15",
    due_at: "2026-10-05T16:00:00-04:00",
    due_at_source: "crol",
    archive_at: "2026-09-15",
    solicitation_number: "BBP Pier 1 Pavilion",
    category_raw: "Construction/Construction Services",
    selection_method: "Request for Proposals",
    contacts: [{ name: "John Zhang", email: "proposals@bbp.nyc" }],
    submit_to: "334 Furman Street, Brooklyn, NY 11201",
    description_text: "Stair remediation work at the Pier 1 pavilion.",
    description_fetched_at: "2026-09-27T11:00:00Z",
    ...over,
  });
}
