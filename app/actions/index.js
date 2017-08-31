import { tileToBBOX } from "@mapbox/tilebelt";
import async from "async";
import eos from "end-of-stream";
import JSONStream from "JSONStream";
import once from "once";
import RNFetchBlob from "react-native-fetch-blob";
import tar from "tar-stream";
import through2 from "through2";

import osmp2p from "../lib/osm-p2p";
import createOsmp2p from "../lib/create-osm-p2p";
import { findPeers } from "../lib/osm-sync";
import { tilesForBounds, timeout } from "../lib";
import {
  selectActiveFeatureTileQueries,
  selectActiveObservationTileQueries,
  selectFeatures,
  selectObservations
} from "../selectors";

const Fetch = RNFetchBlob.polyfill.Fetch;
// replace built-in fetch
window.fetch = new Fetch({
  // enable this option so that the response data conversion handled automatically
  auto: true,
  // when receiving response data, the module will match its Content-Type header
  // with strings in this array. If it contains any one of string in this array,
  // the response body will be considered as binary data and the data will be stored
  // in file system instead of in memory.
  // By default, it only store response data to file system when Content-Type
  // contains string `application/octet`.
  binaryContentTypes: ["image/", "video/", "audio/", "application/gzip"]
}).build();

export const osm = osmp2p(createOsmp2p);

const types = {
  CLEAR_LOCAL_SURVEYS: "CLEAR_LOCAL_SURVEYS",
  CLEAR_REMOTE_SURVEYS: "CLEAR_REMOTE_SURVEYS",
  DISCOVERING_PEERS: "DISCOVERING_PEERS",
  DISCOVERING_PEERS_FAILED: "DISCOVERING_PEERS_FAILED",
  FETCHING_REMOTE_SURVEY: "FETCHING_REMOTE_SURVEY",
  FETCHING_REMOTE_SURVEY_FAILED: "FETCHING_REMOTE_SURVEY_FAILED",
  FETCHING_REMOTE_SURVEY_LIST: "FETCHING_REMOTE_SURVEY_LIST",
  FETCHING_REMOTE_SURVEY_LIST_FAILED: "FETCHING_REMOTE_SURVEY_LIST_FAILED",
  DELETE_LOCAL_SURVEY: "DELETE_LOCAL_SURVEY",
  INITIALIZE_OBSERVATION: "INITIALIZE_OBSERVATION",
  SET_ACTIVE_OBSERVATION: "SET_ACTIVE_OBSERVATION",
  RECEIVED_REMOTE_SURVEY_LIST: "RECEIVED_REMOTE_SURVEY_LIST",
  RECEIVED_REMOTE_SURVEY: "RECEIVED_REMOTE_SURVEY",
  SAVING_OBSERVATION: "SAVING_OBSERVATION",
  SAVING_OBSERVATION_FAILED: "SAVING_OBSERVATION_FAILED",
  OBSERVATION_SAVED: "OBSERVATION_SAVED",
  SYNCING_SURVEY_DATA: "SYNCING_SURVEY_DATA",
  SYNCING_SURVEY_DATA_PROGRESS: "SYNCING_SURVEY_DATA_PROGRESS",
  SYNCING_SURVEY_DATA_FAILED: "SYNCING_SURVEY_DATA_FAILED",
  FINISHED_SYNCING_SURVEY_DATA: "FINISHED_SYNCING_SURVEY_DATA",
  SURVEY_DATA_INDEXED: "SURVEY_DATA_INDEXED",
  SET_AREA_OF_INTEREST: "SET_AREA_OF_INTEREST",
  CLEAR_AREA_OF_INTEREST: "CLEAR_AREA_OF_INTEREST",
  SET_OBSERVATIONS_LAST_SYNCED: "SET_OBSERVATIONS_LAST_SYNCED",
  SET_COORDINATOR_TARGET: "SET_COORDINATOR_TARGET",
  UPDATE_OBSERVATION: "UPDATE_OBSERVATION",
  REPLICATION_STARTED: "REPLICATION_STARTED",
  REPLICATION_COMPLETED: "REPLICATION_COMPLETED",
  INDEXING_STARTED: "INDEXING_STARTED",
  INDEXING_COMPLETED: "INDEXING_COMPLETED",
  OSM_DATA_CHANGED: "OSM_DATA_CHANGED",
  VISIBLE_BOUNDS_UPDATED: "VISIBLE_BOUNDS_UPDATED",
  SELECT_BBOX: "SELECT_BBOX",
  BBOX_FEATURE_SELECTION_FAILED: "BBOX_FEATURE_SELECTION_FAILED",
  BBOX_OBSERVATION_SELECTION_FAILED: "BBOX_OBSERVATION_SELECTION_FAILED",
  BBOX_SELECTED: "BBOX_SELECTED",
  BBOX_CLEARED: "BBOX_CLEARED",
  FEATURE_TILE_QUERY_FAILED: "FEATURE_TILE_QUERY_FAILED",
  QUERYING_TILE_FOR_FEATURES: "QUERYING_TILE_FOR_FEATURES",
  TILE_QUERIED_FOR_FEATURES: "TILE_QUERIED_FOR_FEATURES",
  OBSERVATION_TILE_QUERY_FAILED: "OBSERVATION_TILE_QUERY_FAILED",
  QUERYING_TILE_FOR_OBSERVATIONS: "QUERYING_TILE_FOR_OBSERVATIONS",
  TILE_QUERIED_FOR_OBSERVATIONS: "TILE_QUERIED_FOR_OBSERVATIONS"
};

// fallback to 10.0.2.2 when connecting to the coordinator (host's localhost from the emulator)
const COORDINATOR_FALLBACK_IP = "10.0.2.2";
const COORDINATOR_FALLBACK_PORT = 3210;

export default types;

const extractSurveyBundle = (id, bundle, _callback) => {
  const survey = {};
  const callback = once(err => {
    return _callback(err, survey);
  });
  const extract = tar.extract();

  eos(extract, callback);

  extract.on("entry", (header, stream, next) => {
    stream.on("end", next);

    if (header.name === "survey.json") {
      stream.pipe(
        JSONStream.parse().on("data", data => {
          survey.icons = data.icons;
          delete data.icons;

          survey.definition = Object.assign(data, { id });
        })
      );
    } else {
      const chunks = [];

      stream
        .pipe(
          through2((chunk, enc, done) => {
            chunks.push(chunk);

            done();
          })
        )
        .on("finish", () => {
          const blob = Buffer.concat(chunks);

          survey[header.name] = blob;
        });
    }
  });

  // NOTE: can't attach multiple handlers to these
  bundle.onData(chunk => extract.write(chunk));
  bundle.onEnd(() => extract.end());

  bundle.open();
};

const fetchMeta = (target, cb) => {
  const url = `http://${target.address}:${target.port}`;

  return fetch(`${url}/osm/meta`)
    .then(rsp => {
      if (rsp.status !== 200) {
        return cb(null, {});
      }

      return rsp.json().then(data => cb(null, data));
    })
    .catch(cb);
};

const getPeerInfo = (dispatch, callback) => {
  dispatch({
    type: types.DISCOVERING_PEERS
  });

  return findPeers((err, peers) => {
    if (err) {
      return callback(err);
    }

    let targetIP = COORDINATOR_FALLBACK_IP;
    let targetPort = COORDINATOR_FALLBACK_PORT;

    if (peers.length > 0) {
      targetIP = peers[0].address;
      targetPort = peers[0].port;
    }

    dispatch({
      type: types.SET_COORDINATOR_TARGET,
      target: { address: targetIP, port: targetPort }
    });

    return callback(null, targetIP, targetPort);
  });
};

const checkRemoteOsmMeta = (target, dispatch, cb) => {
  if (!target || !target.address || !target.port) {
    return getPeerInfo(dispatch, (err, targetIP, targetPort) => {
      if (err) {
        return dispatch({ type: types.DISCOVERING_PEERS_FAILED, error: err });
      }

      target = { address: targetIP, port: targetPort };
      fetchMeta(target, cb);
    });
  }

  return fetchMeta(target, cb);
};

const checkOsmMeta = (target, getState, dispatch, cb) => {
  const { osm: { areaOfInterest } } = getState();

  checkRemoteOsmMeta(target, dispatch, function(err, res) {
    if (err) return cb(err);
    if (!areaOfInterest) return cb(null, true, res);

    if (areaOfInterest.uuid === res.uuid) {
      return cb(null, false);
    }

    return cb(null, true, res);
  });
};

export const syncData = target => (dispatch, getState) => {
  checkOsmMeta(
    target,
    getState,
    dispatch,
    (err, shouldImportOsm, areaOfInterest) => {
      if (err) return console.log(err);
      console.log("shouldImportOsm", shouldImportOsm);

      dispatch({
        type: types.SYNCING_SURVEY_DATA
      });

      const progressFn = i => {
        console.log("progress", i);
        dispatch({
          type: types.SYNCING_SURVEY_DATA_PROGRESS,
          progress: i
        });
      };

      if (shouldImportOsm) {
        osm.replicate(
          target,
          {
            progressFn
          },
          err => {
            if (err) {
              return dispatch({
                type: types.SYNCING_SURVEY_DATA_FAILED
              });
            }

            dispatch({
              type: types.FINISHED_SYNCING_SURVEY_DATA
            });

            dispatch({
              type: types.SET_AREA_OF_INTEREST,
              areaOfInterest
            });

            dispatch({
              type: types.SET_OBSERVATIONS_LAST_SYNCED,
              observationsLastSynced: Date.now()
            });
          }
        );
      } else {
        // only sync observations

        progressFn(0);

        osm.sync.replicateObservationDb(target, err => {
          progressFn(1);

          if (err) {
            return dispatch({ type: types.SYNCING_SURVEY_DATA_FAILED });
          }

          dispatch({ type: types.FINISHED_SYNCING_SURVEY_DATA });
        });
      }
    }
  );
};

export const clearLocalSurveys = () => (dispatch, getState) =>
  dispatch({
    type: types.CLEAR_LOCAL_SURVEYS
  });

export const deleteLocalSurvey = surveyId => (dispatch, getState) =>
  dispatch({
    type: types.DELETE_LOCAL_SURVEY,
    id: surveyId
  });

export const clearRemoteSurveys = () => (dispatch, getState) =>
  dispatch({
    type: types.CLEAR_REMOTE_SURVEYS
  });

export const fetchRemoteSurvey = (id, url) => (dispatch, getState) => {
  dispatch({
    id,
    type: types.FETCHING_REMOTE_SURVEY
  });

  return timeout(fetch(`${url}/bundle`), 1000)
    .then(rsp => rsp.rawResp())
    .then(rsp => rsp.readStream())
    .then(
      stream =>
        new Promise((resolve, reject) =>
          extractSurveyBundle(id, stream, (err, survey) => {
            if (err) {
              return reject(new Error(err));
            }

            return resolve(survey);
          })
        )
    )
    .then(survey => {
      dispatch({
        id,
        type: types.RECEIVED_REMOTE_SURVEY,
        survey
      });
    })
    .catch(error =>
      dispatch({
        id,
        type: types.FETCHING_REMOTE_SURVEY_FAILED,
        error
      })
    );
};

export const listRemoteSurveys = () => (dispatch, getState) => {
  return getPeerInfo(dispatch, (err, targetIP, targetPort) => {
    if (err) {
      console.warn(err);
      return dispatch({
        type: types.DISCOVERING_PEERS_FAILED,
        error: err
      });
    }

    dispatch({
      type: types.FETCHING_REMOTE_SURVEY_LIST
    });

    return timeout(fetch(`http://${targetIP}:${targetPort}/surveys/list`), 1000)
      .then(rsp => rsp.json())
      .then(surveys =>
        dispatch({
          type: types.RECEIVED_REMOTE_SURVEY_LIST,
          surveys: surveys.map(x => ({
            ...x,
            url: `http://${targetIP}:${targetPort}/surveys/${x.id}`,
            target: {
              address: targetIP,
              port: targetPort
            }
          }))
        })
      )
      .catch(error =>
        dispatch({
          type: types.FETCHING_REMOTE_SURVEY_LIST_FAILED,
          error
        })
      );
  });
};

export const initializeObservation = observation => dispatch => {
  return dispatch({
    type: types.INITIALIZE_OBSERVATION,
    observation
  });
};

export const setActiveObservation = observation => dispatch =>
  dispatch({
    type: types.SET_ACTIVE_OBSERVATION,
    observation
  });

export const updateObservation = observation => dispatch =>
  dispatch({
    type: types.UPDATE_OBSERVATION,
    observation
  });

export const saveObservation = observation => (dispatch, getState) => {
  dispatch({
    type: types.SAVING_OBSERVATION
  });

  return osm.createObservation(observation, error => {
    if (error) {
      return dispatch({
        type: types.SAVING_OBSERVATION_FAILED,
        error
      });
    }

    // TODO dispatch an action invalidating the observation tile containing what was just created
    return dispatch({
      type: types.OBSERVATION_SAVED
    });
  });
};

export const replicationStarted = () => dispatch =>
  dispatch({ type: types.REPLICATION_STARTED });

export const replicationCompleted = () => dispatch =>
  dispatch({ type: types.REPLICATION_COMPLETED });

export const indexingStarted = () => dispatch =>
  dispatch({ type: types.INDEXING_STARTED });

export const indexingCompleted = () => dispatch =>
  dispatch({ type: types.INDEXING_COMPLETED });

export const dataChanged = () => dispatch =>
  dispatch({ type: types.OSM_DATA_CHANGED });

export const queryTileForFeatures = tile => (dispatch, getState) => {
  const activeTileQueries = selectActiveFeatureTileQueries(getState());
  const features = selectFeatures(getState());
  const tileKey = tile.join("/");

  // check state to see if this tile is already being queried or exists
  if (activeTileQueries.includes(tileKey) || features[tileKey] != null) {
    console.log("skipping", tileKey);
    return;
  }

  dispatch({ type: types.QUERYING_TILE_FOR_FEATURES, tile });

  const bbox = tileToBBOX(tile);

  console.log("querying OSM for", [[bbox[1], bbox[3]], [bbox[0], bbox[2]]]);

  return osm.queryOSM(
    [[bbox[1], bbox[3]], [bbox[0], bbox[2]]],
    (error, results) => {
      if (error) {
        console.warn(error);
        return dispatch({ type: types.FEATURE_TILE_QUERY_FAILED, error });
      }

      console.log("results for", tileKey, results.length);

      // TODO replace this with filtering based on presets OR store the raw data
      const filtered = results.filter(item => {
        return (
          item.type === "node" &&
          item.lat &&
          item.lon &&
          item.tags &&
          item.tags.name
        );
      });

      console.log("filtered features for", tileKey, filtered.length);

      return dispatch({
        type: types.TILE_QUERIED_FOR_FEATURES,
        tile,
        features: filtered
      });
    }
  );
};

export const queryTileForObservations = tile => (dispatch, getState) => {
  const activeTileQueries = selectActiveObservationTileQueries(getState());
  const observations = selectObservations(getState());
  const tileKey = tile.join("/");

  // check state to see if this tile is already being queried or exists
  if (activeTileQueries.includes(tileKey) || observations[tileKey] != null) {
    console.log("skipping", tileKey);
    return;
  }

  dispatch({ type: types.QUERYING_TILE_FOR_OBSERVATIONS, tile });

  const bbox = tileToBBOX(tile);

  console.log("querying observations for", [
    [bbox[1], bbox[3]],
    [bbox[0], bbox[2]]
  ]);

  return osm.queryObservations(
    [[bbox[1], bbox[3]], [bbox[0], bbox[2]]],
    (error, observations) => {
      if (error) {
        console.warn(error);
        return dispatch({ type: types.OBSERVATION_TILE_QUERY_FAILED, error });
      }

      console.log("observations for", tileKey, observations.length);

      return dispatch({
        type: types.TILE_QUERIED_FOR_OBSERVATIONS,
        tile,
        observations
      });
    }
  );
};

export const updateVisibleBounds = bounds => dispatch => {
  dispatch({ type: types.VISIBLE_BOUNDS_UPDATED, bounds });

  const tiles = tilesForBounds(bounds);

  tiles.forEach(tile => {
    dispatch(queryTileForFeatures(tile));
    dispatch(queryTileForObservations(tile));
  });
};

const queryBboxForFeatures = (q, dispatch, callback) => {
  return osm.queryOSM(q, (error, results) => {
    if (error) {
      console.warn(error);
      dispatch({ type: types.BBOX_FEATURE_SELECTION_FAILED, error });
      return callback(null, []);
    }

    // TODO: replace this with filtering based on presets
    const filtered = results.filter(item => {
      return (
        item.type === "node" &&
        item.lat &&
        item.lon &&
        item.tags &&
        item.tags.name
      );
    });

    return callback(null, filtered);
  });
};

const queryBboxForObservations = (q, dispatch, callback) => {
  return osm.queryObservations(q, (error, observations) => {
    if (error) {
      console.warn(error);
      dispatch({ type: types.BBOX_OBSERVATION_SELECTION_FAILED, error });
      return callback(null, []);
    }

    return callback(null, observations);
  });
};

export const selectBbox = bounds => dispatch => {
  dispatch({ type: types.SELECT_BBOX, bounds });

  var q = [[bounds[0], bounds[2]], [bounds[1], bounds[3]]];

  return async.parallel(
    {
      features: async.apply(queryBboxForFeatures, q, dispatch),
      observations: async.apply(queryBboxForObservations, q, dispatch)
    },
    (err, { features, observations }) => {
      return dispatch({
        type: types.BBOX_SELECTED,
        bounds,
        features,
        observations
      });
    }
  );
};

export const clearBbox = () => dispatch =>
  dispatch({ type: types.BBOX_CLEARED });
