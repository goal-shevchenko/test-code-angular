import { ActivatedRoute } from '@angular/router';
import { Component, OnInit, ViewChild } from '@angular/core';
import { Map, LngLatBounds } from 'mapbox-gl';
import * as MapboxDraw from '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw';
import { Store, select } from '@ngrx/store';
import { Actions } from "@ngrx/effects";
import { take, distinctUntilChanged, debounceTime, switchMap, tap, map, filter } from 'rxjs/operators'
import { Observable, Subject, merge } from 'rxjs';
import { LngLat, MapLayerMouseEvent } from 'mapbox-gl';
import { GeoJsonProperties } from 'geojson';
import { NgbTypeahead } from '@ng-bootstrap/ng-bootstrap';
import { plainToClass } from 'class-transformer';

import { getConfigStatesKeyValues, ConfigState } from '@app/core/store/config';
import { RestService, LocationGroup, DomicileLocation, MapboxPlace, MapboxHelperService } from '@app/core/services';
import { MinifyMenu } from '@app/core/store/layout';
import { mapConfig } from '@app/core/smartadmin.config';
import { DateService } from '@app/shared/pipes/timezone-handler.pipe';
import { ExitEditMode } from '@app/core/store/shortcuts';

@Component({
  selector: 'app-locations',
  templateUrl: './locations.component.html',
  styleUrls: ['./locations.component.css']
})
export class LocationsComponent implements OnInit {

  groupId: string = null;
  groups: LocationGroup[] = [];
  globalGroups: LocationGroup[] = [];
  localGroups: LocationGroup[] = [];
  activeGroup: LocationGroup;
  locations: DomicileLocation[];
  searchedNotPresented: DomicileLocation[];

  /**
   * Bounds definition for the map to fit.
   */
  fitBounds: number[][] = this.mbHelper.calculateBounds(null);
  fitBoundsOptions = {
    padding: { top: 25, bottom: 25, left: 25, right: 25 }
  }

  /**
   * Create location functionality
   */
  draw: MapboxDraw;
  addMapboxDraw() {
    if (this.draw) {
      this.theMapInstance.removeControl(this.draw);
      this.draw = null;
    }
    if (this.activeGroup && !this.activeGroup.isGlobal() && this.theMapInstance) {
      this.draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {
          polygon: true,
          trash: true
        }
      });
      this.theMapInstance.addControl(this.draw, 'top-right');
    }
  }

  createLocation(e) {
    // TODO: move to common place
    function getNowUTC() {
      const now = new Date();
      return new Date(now.getTime() + (now.getTimezoneOffset() * 60000));
    }

    var rings = e.features[0].geometry.coordinates;
    let locationData = {
      name: this.dateService.transform2Time(getNowUTC()),
      polygon: {
        srid: null,
        rings: rings
      },
      locationGroupId: this.groupId
    }
    this.restService.createLocation(locationData)
      .subscribe(
        (data: DomicileLocation) => {
          this.locations = [data, ...this.locations];
          // this.locations.unshift(data);
          this.draw.deleteAll();

          // Let's open popup
          this.displayModal(data);
        }
      );
  }

  isCreate: boolean;
  createDraw(e) {
    if (this.isCreate) {
      this.createLocation(e)
    } else {
      if (this.isCreatePoint) {
        this.createPoint(e);
      } else {
        this.createPolygon(e);
      }
    }
  }
  modeChanged(e) {
    if (e.mode === 'draw_polygon') { // fired from the controller
      this.isCreate = true;
    }
  }

  /**
   * Create/update polygon for locations.
   * IMPORTANT: `modeChanged()` will not be fired when directly calling `MapboxDraw.changeMode('some_mode')`
   */
  initCreatePolygon() { // fired from the custom button
    this.isCreate = false;
    this.isCreatePoint = false;
    this.draw.changeMode('draw_polygon');
  }

  createPolygon(e) {
    var rings = e.features[0].geometry.coordinates;
    let updateData = {
      polygon: {
        srid: null,
        rings: rings
      }
    }
    this.updateLocation(updateData);
  }

  updateLocation(data: any) {
    let locationId = this.currentLocation.id;
    let updateData = {
      id: locationId,
      ...data
    }
    this.restService.updateLocation(updateData)
      .subscribe(
        updated => {
          const index = this.locations.findIndex(
            location => location.id === locationId
          )
          this.locations[index] = updated;
          this.draw.deleteAll();

          // Try to reopen popup:
          this.displayModal(updated);
        }
      );
  }

  /**
   * Create/update point for locations.
   * IMPORTANT: `modeChanged()` will not be fired when directly calling `MapboxDraw.changeMode('some_mode')`
   */
  initCreatePoint() {
    this.isCreate = false;
    this.isCreatePoint = true;
    this.draw.changeMode('draw_point');
  }
  isCreatePoint: boolean;

  createPoint(e) {
    var point = e.features[0].geometry.coordinates;
    let updateData = {
      point: {
        x: point[0],
        y: point[1]
      }
    }
    this.updateLocation(updateData);
  }

  /**
   * Workaround for the map auto-resize issue.
   */
  theMapInstance: Map;
  imageLoaded: boolean = false;
  onLoad(mapInstance: Map) {
    this.theMapInstance = mapInstance;
    this.theMapInstance.on('draw.create', this.createDraw.bind(this));
    this.theMapInstance.on('draw.modechange', this.modeChanged.bind(this));

    this.addMapboxDraw();
  }
  onMinifyMenu = this.actions$.subscribe(action => {
    if (action instanceof MinifyMenu) {
      this.theMapInstance.resize();
    }
  });

  /**
   * Map styling logic.
   */
  style: string = mapConfig.STREETS;
  isDefault: boolean = true;
  toggleStyle() {
    this.style = this.isDefault ? mapConfig.SATELLITE : mapConfig.STREETS;
    this.isDefault = !this.isDefault;
  }

  onGroupChange(groupId): void {
    if (this.thePopup && this.thePopup.popupInstance) {
      this.thePopup.popupInstance.remove();
    }
    this.activeGroup = this.groups.find(group => group.id === this.groupId);
    this.addMapboxDraw();
    this.loadLocations(this.groupId);
  }

  /**
   * Location delete functionality.
   */
  deleteInitiated: boolean;
  deleted: boolean;

  initDeleteLocation() {
    this.deleteInitiated = true;
  }
  deleteLocation(locationId) {
    this.restService.deleteLocation(locationId)
      .subscribe(
        good => {
          this.locations = this.locations.filter(
            location => location.id !== locationId
          );
          this.deleted = true;
        },
        error => {
          console.log("Error occured during location deletion.");
        }
      );
  }

  /**
   * Location edit functionality
   */
  @ViewChild("thePopup") thePopup: any;

  edit: boolean;
  locationData: any;
  states: any[];
  initEditLocation(properties) {
    this.locationData = {
      ...properties
    }
    this.edit = true;
  }
  cancelEditLocation() {
    this.edit = false;
  }

  /** Shortcuts logic */
  onExitEditMode = this.actions$.subscribe(action => {
    if (action instanceof ExitEditMode) {
      this.cancelEditLocation();
    }
  });

  doEditLocation() {
    let locationId = this.locationData.id;
    this.restService.updateLocation(this.locationData)
      .subscribe(
        updated => {
          const index = this.locations.findIndex(
            location => location.id === locationId
          )
          this.locations[index] = updated;

          this.thePopup.popupInstance.remove();
          let toClick = this.thePopup.popupInstance.getLngLat();
          this.displayModal(updated, toClick);
        }
      );
  }

  /**
   * Typeahead serch functionality.
   */
  searching: boolean;
  @ViewChild('searchInput') _searchInput: NgbTypeahead;
  focus$ = new Subject<string>();
  click$ = new Subject<string>();

  model: any;
  searchPlaces = (text$: Observable<string>) => {
    const debouncedText$ = text$.pipe(debounceTime(300), distinctUntilChanged());
    const clicksWithClosedPopup$ = this.click$.pipe(filter(() => !this._searchInput.isPopupOpen()));
    const inputFocus$ = this.focus$;

    return merge(debouncedText$, inputFocus$, clicksWithClosedPopup$).pipe(
      tap(() => this.searching = true),
      switchMap(term =>
        this.restService.doMixedSearch(this.groupId, term).pipe(
          map(list => list.slice(0, 15))
        )
      ),
      tap(() => this.searching = false)
    );
  }

  clickSelected(item) {
    item.preventDefault();
    let isLocation = item.item.isLocation;
    let entry: any = item.item.entry;

    if (isLocation) {
      // Let's check if location entry is displayed and display it if not
      let theLocation = [...this.searchedNotPresented, ...this.locations].find(function (next) {
        return next.id === entry.id;
      });
      if (!theLocation) {
        this.searchedNotPresented.push(entry);
        console.log(this.searchedNotPresented);
      }

      this.showLocation(entry);
    } else {
      this.showPlace(entry);
    }
  }

  showPlace(place: MapboxPlace) {
    let point = place.center;
    let lngLat = new LngLat(point[0], point[1]);
    this.theMapInstance.setCenter(lngLat);
    if (place.bbox && place.bbox.length === 4) {
      let bounds: LngLatBounds = new LngLatBounds(new LngLat(place.bbox[0], place.bbox[1]), new LngLat(place.bbox[2], place.bbox[3]));
      this.theMapInstance.fitBounds(bounds);
    } else {
      // fly to exact location
      this.theMapInstance.flyTo({
        center: lngLat,
        zoom: 17
      });
    }
  }

  /**
   * Show location logic
   */
  showLocation(location: DomicileLocation) {
    this.displayModal(location, null, true);
  }

  selectedElement: GeoJsonProperties;
  currentLocation: DomicileLocation;
  selectedLngLat: LngLat;
  cursorStyle: string;

  onClick(evt: MapLayerMouseEvent) {
    let properties = JSON.parse(evt.features![0].properties.asString);
    let location = plainToClass(DomicileLocation, properties as DomicileLocation);
    this.displayModal(location, evt.lngLat);
  }

  displayModal(location: DomicileLocation, lngLat: LngLat = null, jump: boolean = false) {
    // Reset all modal actions
    this.edit = false;
    this.deleted = false;
    this.deleteInitiated = false;

    if (!lngLat) {
      let point = location.getClickablePoint();
      lngLat = new LngLat(point[0], point[1]);
    }

    // Display modal
    this.selectedLngLat = lngLat;
    this.currentLocation = location;
    this.selectedElement = {
      ...location,
      "state": location.state || "" // In case of `null` replacing with empty string to show `-- None --` pre-selected within edit
    };

    if (jump) { // Let's jump
      this.theMapInstance.setCenter(lngLat);
      let boundNums: number[][] = this.mbHelper.calculateBounds([location]);
      let bounds: LngLatBounds = new LngLatBounds(new LngLat(boundNums[0][0], boundNums[0][1]), new LngLat(boundNums[1][0], boundNums[1][1]));
      this.theMapInstance.fitBounds(bounds, this.fitBoundsOptions);
    }
  }

  /**
   * Constructor to instantiate an instance of LocationsComponent.
   */
  constructor(
    private dateService: DateService,
    private mbHelper: MapboxHelperService,
    private route: ActivatedRoute,
    private actions$: Actions,
    private restService: RestService,
    private store: Store<ConfigState>) { }

  ngOnInit() {
    this.store.pipe(select(getConfigStatesKeyValues), take(1)).subscribe(val => {
      this.states = val;
    });

    this.groupId = this.route.snapshot.queryParamMap.get("groupId");
    this.restService.get1000LocationGroups()
      .subscribe(
        data => {
          this.groups = data;
          this.globalGroups = this.groups.filter(group => group.isGlobal());
          this.localGroups = this.groups.filter(group => !group.isGlobal());

          this.activeGroup = this.groups.find(group => group.id === this.groupId) || this.groups[0];
          this.groupId = this.activeGroup.id;
          this.addMapboxDraw();

          this.loadLocations(this.groupId);
        }
      );
  }

  loadLocations(groupId: string, page: number = 1) {
    this.restService.getLocationsFor(groupId, page, this.perPage)
      .subscribe(
        data => {
          this.locations = data.results;
          this.searchedNotPresented = [];
          this.locationsCount = data.resultCount;
          this.fitBounds = this.mbHelper.calculateBounds(this.locations);
        }
      );
  }

  /**
   * Pagination logic.
   */
  page: number = 1;
  perPage = 500;
  locationsCount: number;

  changePage(newPage) {
    if (this.thePopup && this.thePopup.popupInstance) {
      this.thePopup.popupInstance.remove();
    }
    this.loadLocations(this.groupId, newPage);
  }

}
