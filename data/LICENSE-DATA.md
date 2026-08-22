# Data licences

The MIT licence in the repository root covers the **code** only. The baked
data files in this directory carry the licences of the sources they were
derived from:

## OSM-derived files — ODbL v1.0

The following files are derivative databases of OpenStreetMap data, produced
by this repository's bake scripts (stitching, branch-splitting, resampling),
and are licensed under the
[Open Database License v1.0](https://opendatacommons.org/licenses/odbl/1-0/):

- `branches/**`
- `lines/**`
- `stations/**`
- `nr/**`
- `dubai/**`

© OpenStreetMap contributors. If you extract or build upon these files, the
ODbL's share-alike terms apply to the resulting database.

## TfL-derived content

Stop sequences and line metadata baked from the TfL Unified API are used under
the [TfL Open Data licence](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service)
(Powered by TfL Open Data; contains OS data © Crown copyright and database
rights 2016 and Geomni UK Map data © and database rights 2019).

## Runtime-learned data (not in git)

Bus route geometry learned at runtime (`bus-routes/learned/`, gitignored) is
derived from DfT Bus Open Data Service SIRI-VM GPS traces under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
— not from OpenStreetMap, so no ODbL obligations attach to it.
