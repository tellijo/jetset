/* eslint-disable no-console */
import config from '../config';

function shouldLog() {
  return config.mode === 'development';
}

function formatArgs( args ) {
  return args.reduce(( memo, item ) => {
    if ( typeof item === 'string' && !~item.indexOf( 'color:' ) ) { 
      memo[0] += item;
    } else {
      memo.push( item );
    }
    return memo;
  }, ['']);
}

export default function log( ...args ) {
  if ( shouldLog() ) {
    console.log( ...formatArgs( args ) );
  }
}

export function logWithStack( ...args ) {
  if ( shouldLog() ) {
    console.groupCollapsed( ...formatArgs( args ) );
    console.log( getStack() );
    console.groupEnd();
  }
}

export function logError( ...args ) {
  if ( shouldLog() ) {
    console.error( ...args );
  }
}

export function logGroup( ...args ) {
  if ( shouldLog() ) {
    console.groupCollapsed( ...args );
  }
}

export function logGroupEnd( ...args ) {
  if ( shouldLog() ) {
    console.groupEnd( ...args );
  }
}

export function getStack() {
  const { stack } = new Error();
  return stack
    ? stack.split('\n').slice(4).map( item => item.trim() ).join( '\n' )
    : '';
}
