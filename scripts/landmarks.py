"""Labelled places. Positions snap to the OSM feature carrying the name (or one of `osm`), else lat/lon.

`far`: how far away (m) the label still shows. Heights are architectural heights in metres.
"""
TOWER, MUSEUM, PLACE = 9000, 3500, 1800

LANDMARKS = [
    # Bunker Hill & Financial District skyline
    dict(name="Wilshire Grand Center", kind="tower", height=335, year=2017, by="AC Martin", far=TOWER,
         lat=34.0499, lon=-118.2603),
    dict(name="U.S. Bank Tower", kind="tower", height=310, year=1989, by="Pei Cobb Freed", far=TOWER,
         osm=["US Bank Tower", "Library Tower"], lat=34.0511, lon=-118.2543),
    dict(name="Aon Center", kind="tower", height=262, year=1974, far=TOWER, lat=34.0503, lon=-118.2569),
    dict(name="Two California Plaza", kind="tower", height=229, year=1992, far=TOWER, lat=34.0527, lon=-118.2508),
    dict(name="Gas Company Tower", kind="tower", height=228, year=1991, by="SOM", far=TOWER, lat=34.0497, lon=-118.2553),
    dict(name="Bank of America Plaza", kind="tower", height=224, year=1975, far=TOWER, osm=["Bank of America"],
         lat=34.0540, lon=-118.2533),
    dict(name="777 Tower", kind="tower", height=221, year=1991, by="César Pelli", far=TOWER, lat=34.0479, lon=-118.2602),
    dict(name="Wells Fargo Center", kind="tower", height=220, year=1983, far=TOWER, osm=["Wells Fargo Center North Tower"],
         lat=34.0521, lon=-118.2538),
    # Grand Avenue culture
    dict(name="Walt Disney Concert Hall", kind="concert hall", year=2003, by="Frank Gehry", far=TOWER,
         lat=34.0553, lon=-118.2498),
    dict(name="The Broad", kind="museum", year=2015, by="Diller Scofidio + Renfro", far=MUSEUM, lat=34.0544, lon=-118.2502),
    dict(name="MOCA Grand Avenue", kind="museum", year=1986, by="Arata Isozaki", far=MUSEUM,
         osm=["Museum of Contemporary Art", "The Museum of Contemporary Art"], lat=34.0533, lon=-118.2506),
    dict(name="The Grand LA", kind="towers", year=2022, by="Frank Gehry", far=MUSEUM, osm=["The Grand"],
         lat=34.0559, lon=-118.2486),
    dict(name="Cathedral of Our Lady of the Angels", kind="cathedral", year=2002, by="Rafael Moneo", far=MUSEUM,
         lat=34.0577, lon=-118.2456),
    dict(name="Los Angeles Central Library", kind="library", year=1926, by="Bertram Goodhue", far=MUSEUM,
         osm=["Central Library"], lat=34.0505, lon=-118.2551),
    dict(name="Angels Flight", kind="funicular", year=1901, far=PLACE, lat=34.0514, lon=-118.2502),
    # Civic Center
    dict(name="Los Angeles City Hall", kind="city hall", height=138, year=1928, far=TOWER, osm=["City Hall"],
         lat=34.0537, lon=-118.2427),
    dict(name="Grand Park", kind="park", year=2012, far=MUSEUM, lat=34.0560, lon=-118.2460),
    # Historic Core
    dict(name="Bradbury Building", kind="landmark", year=1893, far=PLACE, lat=34.0505, lon=-118.2479),
    dict(name="Grand Central Market", kind="market", year=1917, far=PLACE, lat=34.0508, lon=-118.2490),
    dict(name="Pershing Square", kind="square", far=MUSEUM, lat=34.0485, lon=-118.2533),
    dict(name="Broadway Theater District", kind="district", far=MUSEUM, lat=34.0458, lon=-118.2540),
    # East side
    dict(name="Union Station", kind="station", year=1939, far=TOWER, osm=["Los Angeles Union Station"],
         lat=34.0562, lon=-118.2365),
    dict(name="Olvera Street", kind="historic street", far=PLACE, lat=34.0574, lon=-118.2378),
    dict(name="Little Tokyo", kind="district", far=MUSEUM, lat=34.0500, lon=-118.2400),
    dict(name="Japanese American National Museum", kind="museum", year=1992, far=PLACE, lat=34.0496, lon=-118.2389),
    dict(name="Chinatown", kind="district", far=MUSEUM, lat=34.0623, lon=-118.2383),
    dict(name="Arts District", kind="district", far=MUSEUM, lat=34.0410, lon=-118.2340),
    dict(name="Sixth Street Viaduct", kind="bridge", year=2022, by="Michael Maltzan", far=TOWER,
         osm=["Sixth Street Viaduct", "6th Street Viaduct"], lat=34.0385, lon=-118.2295),
    dict(name="Los Angeles River", kind="river", far=TOWER, lat=34.0450, lon=-118.2310),
    # South Park
    dict(name="Crypto.com Arena", kind="arena", year=1999, far=TOWER, osm=["Staples Center"], lat=34.0430, lon=-118.2673),
    dict(name="L.A. Live", kind="entertainment district", year=2007, far=MUSEUM, osm=["LA Live"], lat=34.0446, lon=-118.2660),
    dict(name="Los Angeles Convention Center", kind="convention center", year=1971, far=MUSEUM,
         lat=34.0403, lon=-118.2696),
    dict(name="Oceanwide Plaza", kind="unfinished towers", far=MUSEUM, lat=34.0435, lon=-118.2637),
    dict(name="Fashion District", kind="district", far=MUSEUM, osm=["Santee Alley"], lat=34.0386, lon=-118.2530),
]
