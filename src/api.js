import React from 'react';
import PropTypes from 'prop-types';
import { List, Map } from 'immutable';
import initFetch from 'iso-fetch-stream';

import { isSchema, getIdField } from './lib/schema';
import store from './store';
import logger, { logError, logWarn } from './lib/log';
import getQueryString from './lib/query_string';

/* basic state tree design for api.js
* {
*   $api: {
*     [url]: {
*       [resource]: {
*         models: {
*           [id]: {
*             [key]: any,
*             _fetched?: boolean
*           }
*         },
*         requests: {
*           [url]: {
*             pending?: boolean,
*             error?: Object,
*             data?: List | Map
*           }
*         }
*       }
*     }
*   }
* }
*/

// TODO: use some more specific method from store's undo implementation
const isUndo = () => store.getState( '_reset' );

function createActions({ url, ...props }) {

  const fetchOptions = props.credentials ? { credentials: props.credentials } : {};
  if ( props.auth || props.authorization ) fetchOptions.headers = { Authorization: props.auth || props.authorization };
  const fetch = initFetch( fetchOptions );

  return Object.keys( props ).reduce(( memo, key ) => {

    if ( isSchema( props[ key ] ) ) {

      const schema       = props[ key ].schema || props[ key ];
      const getData      = props[ key ].getData || ( data => data );
      const idField      = getIdField( schema );
      const resourceType = schema.title;
      const resourcePath = `/${resourceType}`;

      const routes = Object.assign({
        create: () => resourcePath,
        list:   () => resourcePath,
        search: () => resourcePath,
        get:    id => `${resourcePath}/${id}`,
        update: id => `${resourcePath}/${id}`,
        delete: id => `${resourcePath}/${id}`
      }, props[ key ].routes || {} );

      const getState      = key => store.getState([ '$api', url, resourceType ].concat( key || [] ).map( item => String( item ) ) );
      const setState      = ( val, key ) => store.setState([ '$api', url, resourceType ].concat( key || [] ).map( item => String( item ) ), val );
      const setStateQuiet = ( val, key ) => store.setStateQuiet([ '$api', url, resourceType ].concat( key || [] ), val );

      const getRequests = path => getState([ 'requests' ].concat( path || [] ) );
      const getRequestsData = path => getRequests([ path, 'data' ]);
      const setRequests = ( data, path ) => setState( data, [ 'requests' ].concat( path || [] ) );
      const setRequestsData = ( path, data ) => setState( data, [ 'requests', path, 'data' ] );

      const getCollection = path => {
        const collection = getRequestsData( path );
        if ( collection ) {
          const models = getModels();
          return collection.reduce(( memo, id ) => {
            const model = models.get( id );
            if ( model ) return memo.push( model );
            return memo;
          }, List());
        } else {
          return null;
        }
      };

      const setCollection = ( data = List(), path = '/' ) => {
        const state = getState();
        const nextState = state.withMutations( map => {
          const dict = data.reduce(( memo, item ) => ({ ...memo, [item[idField]]: item }), {});
          map.set( 'models', getModels().mergeDeep( dict ) );
          map.setIn([ 'requests', path, 'data' ], List( Object.keys( dict ) ) );
        });
        setState( nextState );
      };

      const clearCollection = ( path = '/' ) => setRequestsData( path, null );
      const clearAll = () => {
        setRequests( Map() );
        setModels( Map() );
      };

      const getModels  = () => getState( 'models' ) || Map();
      const setModels  = data => setState( data, 'models' );
      const getModel   = id => getState([ 'models', id ]);
      const setModel   = ( id, data ) => setState( data, [ 'models', id ] );
      const getPending = path => getState([ 'requests', path, 'pending' ]);
      const setPending = ( path, data ) => setStateQuiet( data, [ 'requests', path, 'pending' ]);
      const getError   = path => getState([ 'requests', path, 'error' ]);
      const setError   = ( path, error, options = {} ) => {
        const method = options.quiet ? setStateQuiet : setState;
        method( error, [ 'requests', path, 'error' ] );
      };

      const setSearchResults = path => data => setCollection( data, path );
      const getSearchResults = path => getCollection( path );

      const removeFromCollections = ( map, id ) =>
        [ ...map.get( 'requests' ).entries() ]
          .reduce(( undo, [path, request] ) => {
            const collection = request.get( 'data' );
            if ( List.isList( collection ) ) {
              const modelIdx = collection.findIndex( modelId => modelId === id );
              if ( ~modelIdx ) {
                const nextCollection = collection.delete( modelIdx );
                map.setIn([ 'requests', path, 'data' ], nextCollection );
                undo.push(() => setCollection( nextCollection.insert( modelIdx, id ), path ));
              }
            }
            return undo;
          }, []);

      const deleteModel = id => {
        const undo = [];
        const state = getState();
        setState( state.withMutations( map => {
          const model = getModel( id );
          if ( model ) {
            map.set( 'models', getModels().delete( id ) );
            undo.push(() => setModels( getModels().set( id, model ) ));
            undo.push( ...removeFromCollections( map, id ) );
          }
        }));
        return undo;
      };

      const updateModel = ( id, vals ) => {
        const undo = [];
        const model = getModel( id );
        if ( model ) {
          setModel( id, model.mergeDeep( vals ) );
          undo.push(() => setModels( getModels().set( id, model ) ) );
        }
        return undo;
      };

      const shouldFetch = path => !isUndo() && !getPending( path ) && !getError( path );

      const api = ['get', 'post', 'put', 'delete' ].reduce(( memo, method ) => ({
        ...memo,
        [method]: ( path, ...args ) => {
          setPending( path, true );
          return fetch[ method ]( `${url}${path}`, ...args )
            .then(
              response => {
                const data = getData( response );
                setPending( path, false );
                setError( path, null, { quiet: true } );
                return data;
              },
              err => {
                setPending( path, false );
                setError( path, err );
                return Promise.reject( err );
              }
            );
        }
      }), {});

      /**
       * api calls
       */
      const fetchAll = path => {
        const route = path || routes.list();
        if ( shouldFetch( route ) ) {
          api.get( route ).then( data => setCollection( data, route ) );
        }
      };

      const fetchOne = id => {
        const route = routes.get( id );
        if ( shouldFetch( route ) ) {
          api.get( route ).then( data => setModel( data[ idField ], { ...data, _fetched: true }));
        }
      };

      const createOne = data => {
        const route = routes.create( data );
        return api.post( route, data ).then( data => {
          fetchAll();
          return data;
        });
      };

      const updateOne = ( id, data ) => {
        const route = routes.update( id, data );
        return api.put( route, data );
      };

      const deleteOne = id => {
        const route = routes.delete( id );
        return api.delete( route );
      };

      const search = route => {
        if ( shouldFetch( route ) ) {
          return api.get( route ).then( data => {
            setSearchResults( route, data );
            return data;
          });
        }
        // TODO: store promise as pending value so it can be used on repeat
        // calls
        return Promise.resolve( 'pending' );
      };


      /**/

      const $clear = id => () => setModel( id, null );
      const $reset = id => () => fetchOne( id );

      const optimisticDelete = id => {
        const undoDelete = deleteModel( id );
        if ( undoDelete.length ) {
          return deleteOne( id ).catch( err => {
            logError( `Failed to delete ${id}`, err );
            undoDelete.forEach( undo => undo() );
            return Promise.reject( err );
          });
        } else {
          return Promise.reject( new Error( 404 ) );
        }
      };

      const $delete = id => ( options = {} ) =>
        options.optimistic === false || !getModel( id )
          ? deleteOne( id ).then(() => deleteModel( id ) )
          : optimisticDelete( id );

      const optimisticUpdate = ( id, vals, options = {} ) => {
        const placeholder = typeof options.optimistic === 'function'
          ? options.optimistic({ id, ...vals })
          : vals;
        const undoUpdate = updateModel( id, placeholder );
        if ( undoUpdate.length ) {
          return updateOne( id, vals ).catch( err => {
            logError( `Failed to update ${id} with vals`, vals, err );
            undoUpdate.forEach( undo => undo() );
            return Promise.reject( err );
          });
        } else {
          return Promise.reject( new Error( 404 ) );
        }
      };

      const $update = id => ( vals, options = {} ) =>
        options.optimistic === false || !getModel( id )
          ? updateOne( id, vals ).then( data => updateModel( id, data ) )
          : optimisticUpdate( id, vals, options );

      const getPlaceholder = ( path = null, dataType = List ) => {
        const placeholder = dataType();
        placeholder.$isPending = true;
        placeholder.$error = path ? getError( path ) : null;
        return placeholder;
      };

      const addRestMethods = model => {
        const id = model.get( idField );
        model.$delete = $delete( id );
        model.$update = $update( id );
        model.$clear  = $clear( id );
        model.$reset  = $reset( id );
        return model;
      };

      const $list = params => {
        const path = routes.list() + ( params ? `?${getQueryString( params )}` : '' );
        const collection = getCollection( path );
        if ( !collection ) {
          fetchAll( path );
          return getPlaceholder( path );
        } else {
          return collection.map( addRestMethods );
        }
      };

      const main = params => $list( params );

      main.$list = $list;

      main.$get = id => {
        const model = getModel( id );
        if ( !model || !model.get( '_fetched' ) ) {
          const path = routes.get( id );
          fetchOne( id );
          const placeholder = getPlaceholder( path, Map );
          placeholder.$delete = $delete( id );
          placeholder.$update = $update( id );
          return placeholder;
        } else {
          return addRestMethods( model );
        }
      };

      // remove the cache for the resource collection
      main.$clear = () => clearCollection();
      main.$clearAll = clearAll;
      main.$reset = fetchAll;


      const optimisticCreate = ( data, options = {} ) => {
        if ( typeof options.optimistic === 'function' ) {
          const nextState = getState().withMutations( map => options.optimistic( map, data ) );
          if ( nextState ) setState( nextState );
          return createOne( data );
        } else {
          logWarn( `Optimistic creates must receive a function that updates the state with the optimistic data. The create will proceed pessimistically.`);
          return createOne( data );
        }
      };

      main.$create = ( data, options = {} ) =>
        !options.optimistic
          ? createOne( data )
          : optimisticCreate( data, options );

      main.$search = ({ route, ...args }) => {
        const queryString = getQueryString( args );
        const fullRoute = ( route || routes.search() ) + `?${queryString}`;
        return search( fullRoute );
      };

      main.$search.results = ({ route, ...args }) => {
        const queryString = getQueryString( args );
        const fullRoute = ( route || routes.search() ) + `?${queryString}`;
        const resultsCached = getSearchResults( fullRoute );
        if ( resultsCached ) {
          return addRestMethods( resultsCached );
        } else {
          const placeholder = List();
          placeholder.$isPending = !!getPending( fullRoute );
          placeholder.$error = getError( fullRoute );
          return placeholder;
        }
      };


      // hang standard api methods off of .api so devs can construct
      // non-standard paths
      main.api = [ 'delete', '$get', 'get', 'post', 'put', 'stream' ].reduce(( memo, method ) => ({
        ...memo,
        [method]: ( path, ...args ) => {
          const route = resourcePath + path;
          if ( method === '$get' ) {
            const cache = getRequestsData( route );
            if ( cache ) {
              return List.isList( cache )
                ? getCollection( route ).map( addRestMethods )
                : cache;
            } else {
              if ( shouldFetch( route ) ) {
                api.get( route, ...args ).then( data => {
                  if ( Array.isArray( data ) ) {
                    setCollection( data, route );
                  } else {
                    setRequestsData( route, data );
                  }
                  return data;
                });
              }
              return getPlaceholder( route );
            }
          } else {
            return api[ method ]( route, ...args );
          }
        }
      }), {});

      main._schema       = schema;
      main._resourceType = resourceType;
      main.getState      = getState;

      memo[ key ] = main;
      if ( typeof window !== 'undefined' ) {
        window.jetset = window.jetset || {};
        window.jetset[ key ] = main;
      }
    }
    return memo;
  }, {} );
}

export default class Api extends React.Component {

  static propTypes = {
    url: PropTypes.string.isRequired,
    // see https://github.com/github/fetch#sending-cookies for reference
    credentials: PropTypes.oneOf( [ 'same-origin', 'include' ] ),
    token: PropTypes.string
  }

  subscriptions = []

  constructor( props ) {
    super( props );
    this.api = createActions( props );
    this.state = { cache: null };
  }

  componentWillMount() {
    this.subscriptions = Object.keys( this.api ).map( key => {
      const resource = this.api[ key ]._resourceType;
      return store.subscribeTo([ '$api', this.props.url, resource ], state => {
        logger(`\uD83C\uDF00 <Api> is re-rendering based on state changes on branch: %c${this.props.url + ' ‣ ' + resource}`, 'color: #5B4532' );
        this.setState({ cache: state });
      });
    });
  }

  componentWillUnmount() {
    this.subscriptions.forEach( subscription => store.unsubscribe( subscription ) );
  }

  render() {
    const { children, ...props } = this.props;
    return children && typeof children.type === 'function'
      ? React.cloneElement( children, { ...props, ...this.api } )
      : children;
  }
}
