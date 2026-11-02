"""Additional bounded landmark identities, measured in the export's metre grid.

The cached OSM footprints and existing roof heights remain authoritative. These
entries select facade treatments; they do not reconstruct sails, crowns or spires.
"""
from palette import M_BROAD, M_DISNEY, M_MISSION, M_US_BANK, M_WILSHIRE


def additional_specs(LandmarkSpec):
    """Construct entries without importing the override engine (no import cycle).

    Anchors and areas were measured with osm.OSM against the cached OSM data.
    Bounds intentionally tolerate small remapping edits, not an entire city block.
    Fallback names still require a building footprint near the measured centroid.
    """
    return (
        LandmarkSpec(
            key="broad", identities=(("way", 427532197),),
            material=M_BROAD, colour="#eeeae0",
            anchor=(2499.59, 775.57), max_distance=35,
            min_area=2800, max_area=4300,
            fallback_names=("The Broad Museum", "The Broad"),
            roof_colour="#eeeae0", roof_material=M_BROAD,
        ),
        LandmarkSpec(
            key="disney", identities=(("relation", 6333150),),
            material=M_DISNEY, colour="#c9ced0",
            anchor=(2618.48, 759.75), max_distance=45,
            min_area=9000, max_area=13500,
            fallback_names=("Walt Disney Concert Hall",),
            roof_colour="#c9ced0", roof_material=M_DISNEY,
            preserve_roof_profile=True,
        ),
        LandmarkSpec(
            # This multipolygon is the 1939 historic terminal building, not the
            # transit stop, station site, tracks, platform roofs or east garage.
            key="union_station", identities=(("relation", 1483140),),
            material=M_MISSION, colour="#e9dec8",
            anchor=(3469.77, 1753.15), max_distance=45,
            min_area=14000, max_area=18500,
            fallback_names=("Union Station", "Los Angeles Union Station"),
        ),
        LandmarkSpec(
            key="us_bank", identities=(("way", 23973401),),
            material=M_US_BANK, colour="#c9c6bb",
            anchor=(1986.20, 722.42), max_distance=30,
            min_area=1800, max_area=2900,
            fallback_names=("U.S. Bank Tower", "US Bank Tower", "Library Tower"),
        ),
        LandmarkSpec(
            key="wilshire", identities=(("way", 496246723),),
            material=M_WILSHIRE, colour="#91aab4",
            anchor=(1570.40, 342.60), max_distance=40,
            min_area=6800, max_area=9800,
            fallback_names=("Wilshire Grand Building", "Wilshire Grand Center"),
        ),
    )
